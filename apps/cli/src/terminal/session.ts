/**
 * The integrated full-screen session: one event-driven terminal application.
 *
 * Raw keypresses fold through the pure input reducer; submitted lines dispatch to
 * the backend; orchestrator SSE events are normalized and folded through the
 * terminal reducer; everything repaints as a single coalesced frame with a real
 * caret. Approvals render in-frame; YOLO auto-approval shows as activity; Ctrl+C
 * cancels a running task then exits; resize recomposes; teardown restores the
 * terminal on stop, on process exit, and on exception. No feature writes
 * presentation text to stdout directly — they emit events.
 *
 * All backend interaction is injected (`SessionBackend`) so the whole loop is
 * testable against fakes with no server and no real TTY.
 */
import readline from "node:readline";
import type { Output } from "../cli/output.js";
import type { AgentMode } from "@morrow/contracts";
import { modeLabel } from "../cli/identity.js";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
import { staticPaletteItems, type PaletteItem } from "./palette.js";
import { composeApp } from "./app-view.js";
import { completionActive, initialInputState, reduceKey, type InputState, type KeyContext } from "./input-state.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
import { yoloPolicyText, yoloStatusText } from "./yolo.js";
import type { SessionMeta, TerminalEvent } from "./events.js";
import type { TermIO } from "./runtime.js";

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_EOL = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

export interface SendOptions {
  mode: AgentMode;
  autoApprove: boolean;
  provider?: string | undefined;
  model?: string | undefined;
  preset: string;
  useMemory: boolean;
}

export interface ApprovalView {
  id: string;
  kind: "command" | "change_set";
  details: Record<string, unknown>;
  projectId: string;
}

export interface SessionBackend {
  send(text: string, opts: SendOptions): Promise<{ taskId: string }>;
  subscribe(taskId: string, signal: AbortSignal): AsyncIterable<RawTaskEvent>;
  cancel(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  getApproval(id: string): Promise<ApprovalView>;
  resolveApproval(id: string, decision: string, trustPattern?: string): Promise<void>;
  getPlan(taskId: string): Promise<Array<{ id: string; title: string; status: string }>>;
  getOutput(taskId: string, toolId?: string): Promise<Array<{ id: string; toolName: string; resultJson?: string | null; errorMessage?: string | null }>>;
  search?(query: string): Promise<Array<{ kind: string; title: string; snippet: string }>>;
}

export interface SessionSettings {
  mode: AgentMode;
  autoApprove: boolean;
  provider?: string | undefined;
  model?: string | undefined;
  preset: string;
  useMemory: boolean;
}

export interface SessionDeps {
  io: TermIO;
  stdin: NodeJS.ReadStream;
  out: Output;
  unicode: boolean;
  meta: SessionMeta;
  settings: SessionSettings;
  backend: SessionBackend;
  commands?: SlashCommand[];
  extraPaletteItems?: PaletteItem[];
  history?: string[];
  now?: () => number;
  maxFps?: number;
}

export class InteractiveSession {
  private term: TerminalState = initialState();
  private input: InputState;
  private settings: SessionSettings;
  private readonly meta: SessionMeta;
  private readonly commands: SlashCommand[];
  private readonly keyCtx: KeyContext;
  private active = false;
  private busy = false;
  private tick = 0;
  private streamStart = 0;
  private streamAbort: AbortController | null = null;
  private currentTaskId: string | null = null;
  private lastTaskId: string | null = null;
  private outputViewer: { title: string; lines: string[] } | null = null;
  private pendingApproval: ApprovalView | null = null;
  private confirmExitWhileBusy = false;
  private resolveDone: (() => void) | null = null;
  private readonly now: () => number;
  /** Source event ids survive SSE reconnects; never fold the same event twice. */
  private readonly seenSourceEvents = new Set<string>();
  private readonly minIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPaintAt = 0;
  private readonly onResize = () => this.requestPaint(true);
  private readonly onExit = () => this.teardown();
  private readonly onKey = (str: string | undefined, key: readline.Key) => this.handleKey(str, key);

  constructor(private readonly deps: SessionDeps) {
    this.meta = deps.meta;
    this.settings = deps.settings;
    this.commands = deps.commands ?? SLASH_COMMANDS;
    this.input = initialInputState(deps.history ?? []);
    this.now = deps.now ?? Date.now;
    this.minIntervalMs = Math.max(1, Math.floor(1000 / (deps.maxFps ?? 30)));
    const paletteItems = [...staticPaletteItems(this.commands), ...(deps.extraPaletteItems ?? [])];
    this.keyCtx = { commands: this.commands, paletteItems };
    this.term = reduce(this.term, { type: "session.started", meta: this.meta });
  }

  /** Run the session until the user exits. Resolves on clean exit. */
  async run(): Promise<void> {
    const { io, stdin } = this.deps;
    this.active = true;
    if (io.isTTY) io.write(ALT_ENTER + HOME + CLEAR_BELOW + PASTE_ON);
    io.on("resize", this.onResize);
    process.once("exit", this.onExit);
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", this.onKey);
    this.heartbeat = setInterval(() => {
      if (this.busy) {
        this.tick++;
        this.requestPaint(true);
      }
    }, this.minIntervalMs * 2);
    if (typeof this.heartbeat.unref === "function") this.heartbeat.unref();
    this.paint();
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  private handleKey(str: string | undefined, key: readline.Key): void {
    if (!this.active) return;
    const k = { str, name: key?.name, ctrl: key?.ctrl, meta: key?.meta, shift: key?.shift };

    if (this.pendingApproval) return void this.handleApprovalKey(k);

    if (this.busy) {
      // Only cancellation and repaint are meaningful while a task runs.
      if (k.ctrl && k.name === "c") return this.interruptBusy();
      if (k.ctrl && k.name === "l") return void this.fullRepaint();
      this.confirmExitWhileBusy = false;
      return;
    }

    const { state, action } = reduceKey(this.input, k, this.keyCtx);
    this.input = state;
    switch (action.type) {
      case "submit":
        void this.onSubmit(action.value);
        break;
      case "exit":
        this.exit();
        break;
      case "clear-screen":
        this.fullRepaint();
        break;
      case "repaint":
        this.requestPaint(false);
        break;
      case "interrupt":
      case "none":
        break;
    }
  }

  private interruptBusy(): void {
    if (this.confirmExitWhileBusy) return this.exit();
    if (this.currentTaskId && this.streamAbort) {
      void this.deps.backend.cancel(this.currentTaskId).catch(() => {});
      this.confirmExitWhileBusy = true;
      this.pushNotice("warn", "Cancelling… (Ctrl+C again to exit)");
    } else {
      this.exit();
    }
  }

  private async onSubmit(value: string): Promise<void> {
    const line = value.trim();
    if (!line) return void this.requestPaint(false);
    if (line.startsWith("/")) return void this.onSlash(line);
    await this.runTask(line);
  }

  // ── Slash commands handled natively in the frame ───────────────────────────

  private async onSlash(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        return this.exit();
      case "clear":
        this.term = { ...this.term, conversation: [], activity: [], tools: [], patches: [] };
        return void this.fullRepaint();
      case "help":
        this.pushNotice("info", "Commands: " + this.commands.map((c) => "/" + c.name).join(" "));
        return void this.requestPaint(false);
      case "mode": {
        const next = arg === "inspect" ? "read-only" : arg === "plan" ? "plan-only" : arg;
        if (next !== "agent" && next !== "read-only" && next !== "plan-only") {
          this.pushNotice("warn", "Usage: /mode [agent|inspect|plan]");
        } else {
          this.settings.mode = next as AgentMode;
          if (this.settings.mode !== "agent") this.settings.autoApprove = false;
          this.refreshModeLabel();
          this.pushNotice("info", `Mode: ${modeLabel(this.settings.mode, this.settings.autoApprove)}`);
        }
        return void this.requestPaint(false);
      }
      case "yolo": {
        if (this.settings.mode !== "agent") {
          this.pushNotice("warn", "YOLO only applies in agent mode. Use /mode agent first.");
        } else {
          if (arg === "status") {
            this.pushNotice("info", yoloStatusText(this.settings.autoApprove));
            return void this.requestPaint(false);
          }
          if (arg === "policy") {
            this.pushNotice("info", yoloPolicyText());
            return void this.requestPaint(false);
          }
          this.settings.autoApprove = arg === "on" ? true : arg === "off" ? false : !this.settings.autoApprove;
          this.refreshModeLabel();
          this.pushNotice(this.settings.autoApprove ? "warn" : "info", yoloStatusText(this.settings.autoApprove));
        }
        return void this.requestPaint(false);
      }
      case "panic":
        this.settings.autoApprove = false;
        this.refreshModeLabel();
        if (this.currentTaskId) void this.deps.backend.cancel(this.currentTaskId).catch(() => {});
        this.pushNotice("warn", "Panic stop: YOLO disabled and active session task cancelled.");
        return void this.requestPaint(true);
      case "continue":
        await this.continueTask();
        return;
      case "model":
        if (arg) {
          this.settings.model = arg === "auto" ? undefined : arg;
          this.meta.model = this.settings.model ?? "auto";
          this.pushNotice("info", `Model: ${this.settings.model ?? "auto"}`);
        } else this.pushNotice("info", `Model: ${this.settings.model ?? "auto"} (use /model <id>)`);
        return void this.requestPaint(false);
      case "provider":
        if (arg) {
          this.settings.provider = arg === "auto" ? undefined : arg;
          this.pushNotice("info", `Provider: ${this.settings.provider ?? "auto"}`);
        } else this.pushNotice("info", `Provider: ${this.settings.provider ?? "auto"}`);
        return void this.requestPaint(false);
      case "preset":
        if (arg) {
          this.settings.preset = arg;
          this.pushNotice("info", `Preset: ${arg}`);
        } else this.pushNotice("info", `Preset: ${this.settings.preset}`);
        return void this.requestPaint(false);
      case "memory":
        this.settings.useMemory = !this.settings.useMemory;
        this.meta.memory = this.settings.useMemory;
        this.pushNotice("info", `Memory ${this.settings.useMemory ? "on" : "off"}`);
        return void this.requestPaint(false);
      case "status":
        this.pushNotice("info", `${this.meta.projectName} · ${this.meta.provider}/${this.meta.model} · ${modeLabel(this.settings.mode, this.settings.autoApprove)} · memory ${this.settings.useMemory ? "on" : "off"}`);
        return void this.requestPaint(false);
      case "search":
        await this.showSearch(arg);
        return void this.requestPaint(false);
      case "output":
        await this.showOutput(arg || undefined);
        return void this.requestPaint(false);
      default:
        this.pushNotice("warn", `/${cmd} isn't available in the interactive view yet — run with MORROW_TUI=0 for the classic command.`);
        return void this.requestPaint(false);
    }
  }

  private async showSearch(query: string): Promise<void> {
    if (!query.trim()) {
      this.pushNotice("info", "Usage: /search <query>");
      return;
    }
    if (!this.deps.backend.search) {
      this.pushNotice("warn", "Search isn't available in this session.");
      return;
    }
    const hits = await this.deps.backend.search(query).catch(() => null);
    if (hits === null) {
      this.pushNotice("warn", "Search failed — is the orchestrator reachable?");
      return;
    }
    if (hits.length === 0) {
      this.pushNotice("info", `No matches for "${query}".`);
      return;
    }
    const lines = hits.map((h, i) => `${String(i + 1).padStart(3, " ")}  [${h.kind}] ${h.title}  —  ${h.snippet.replace(/\s+/g, " ").trim()}`);
    this.outputViewer = { title: `search: ${query} (${hits.length})`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showOutput(toolId?: string): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No command output yet in this session.");
      return;
    }
    const toolCalls = await this.deps.backend.getOutput(this.lastTaskId, toolId);
    const selected = toolId ? toolCalls.find((call) => call.id === toolId) : [...toolCalls].reverse().find((call) => call.toolName === "run_command");
    if (!selected) {
      this.pushNotice("info", toolId ? `No output for tool ${toolId}.` : "No command output yet in this session.");
      return;
    }
    let raw = selected.errorMessage ?? selected.resultJson ?? "(no output captured)";
    try {
      const parsed = JSON.parse(raw) as { stdout?: string; stderr?: string; error?: string; exitCode?: number | null };
      raw = [parsed.exitCode !== undefined ? `exit ${parsed.exitCode ?? "unknown"}` : "", parsed.stdout ?? "", parsed.stderr ?? "", parsed.error ?? ""].filter(Boolean).join("\n");
    } catch { /* retained output may be plain text */ }
    const allLines = raw.split(/\r?\n/);
    const lines = allLines.slice(0, 200).map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`);
    if (allLines.length > lines.length) lines.push("… output capped at 200 lines");
    this.outputViewer = { title: `${selected.toolName} · ${selected.id}`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private refreshModeLabel(): void {
    this.meta.mode = modeLabel(this.settings.mode, this.settings.autoApprove);
    this.term = reduce(this.term, { type: "session.started", meta: this.meta });
  }

  // ── Task streaming ─────────────────────────────────────────────────────────

  private async runTask(text: string): Promise<void> {
    this.applyEvent({ type: "user.message", text });
    this.busy = true;
    this.streamStart = this.now();
    this.confirmExitWhileBusy = false;
    const abort = new AbortController();
    this.streamAbort = abort;
    this.requestPaint(true);
    try {
      const { taskId } = await this.deps.backend.send(text, { ...this.settings });
      this.currentTaskId = taskId;
      this.lastTaskId = taskId;
      for await (const raw of this.deps.backend.subscribe(taskId, abort.signal)) {
        if (raw.type === "plan.created" || raw.type === "step.started" || raw.type === "step.completed") {
          void this.refreshPlan(taskId);
        }
        if (raw.type === "approval.requested") {
          await this.openApproval(raw);
          continue;
        }
        for (const te of mapTaskEvent(raw)) {
          if (te.sourceEventId) {
            if (this.seenSourceEvents.has(te.sourceEventId)) continue;
            this.seenSourceEvents.add(te.sourceEventId);
          }
          this.applyEvent(te);
        }
      }
      this.applyEvent({ type: "assistant.end" });
    } catch (err) {
      this.applyEvent({ type: "task.failed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
      this.currentTaskId = null;
      this.streamAbort = null;
      this.requestPaint(true);
    }
  }

  private async continueTask(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("warn", "No paused task is available to continue.");
      return;
    }
    this.busy = true;
    this.streamStart = this.now();
    const abort = new AbortController();
    this.streamAbort = abort;
    this.currentTaskId = this.lastTaskId;
    this.requestPaint(true);
    try {
      await this.deps.backend.resume(this.lastTaskId);
      for await (const raw of this.deps.backend.subscribe(this.lastTaskId, abort.signal)) {
        if (raw.type === "approval.requested") { await this.openApproval(raw); continue; }
        if (raw.type === "plan.created" || raw.type === "step.started" || raw.type === "step.completed") void this.refreshPlan(this.lastTaskId);
        for (const te of mapTaskEvent(raw)) {
          if (te.sourceEventId && this.seenSourceEvents.has(te.sourceEventId)) continue;
          if (te.sourceEventId) this.seenSourceEvents.add(te.sourceEventId);
          this.applyEvent(te);
        }
      }
      this.applyEvent({ type: "assistant.end" });
    } catch (error) {
      this.pushNotice("error", `Could not continue task: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      this.currentTaskId = null;
      this.streamAbort = null;
      this.requestPaint(true);
    }
  }

  private async refreshPlan(taskId: string): Promise<void> {
    try {
      const steps = await this.deps.backend.getPlan(taskId);
      const known = new Set(["pending", "running", "completed", "failed", "skipped"]);
      this.applyEvent({
        type: "plan.snapshot",
        steps: steps
          .filter((step) => known.has(step.status))
          .map((step) => ({ id: step.id, title: step.title, status: step.status as "pending" | "running" | "completed" | "failed" | "skipped" })),
      });
    } catch (error) {
      this.pushNotice("warn", `Could not refresh task plan: ${error instanceof Error ? error.message : String(error)}`);
      this.requestPaint(false);
    }
  }

  // ── In-frame approvals ─────────────────────────────────────────────────────

  private async openApproval(raw: RawTaskEvent): Promise<void> {
    const id = String((raw.payload as any).approvalId ?? "");
    const kind = (raw.payload as any).kind as "command" | "change_set";
    try {
      const approval = await this.deps.backend.getApproval(id);
      this.pendingApproval = { id, kind, details: approval.details, projectId: approval.projectId };
      this.requestPaint(true);
    } catch (err) {
      this.pushNotice("error", `Could not load approval: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleApprovalKey(k: { str?: string | undefined; name?: string | undefined; ctrl?: boolean | undefined }): void {
    const ap = this.pendingApproval;
    if (!ap) return;
    const ch = (k.str ?? "").toLowerCase();
    let decision: string | null = null;
    let trust: string | undefined;
    if (ch === "y") decision = "allow_once";
    else if (ch === "n" || (k.ctrl && k.name === "c")) decision = "deny";
    else if (ch === "t" && ap.kind === "command") {
      decision = "trust_project";
      trust = String((ap.details as any).pattern ?? "");
    } else return;

    this.pendingApproval = null;
    const source = decision === "deny" ? "denied" : decision === "trust_project" ? "trusted" : "approved";
    this.pushNotice(decision === "deny" ? "warn" : "info", `${ap.kind === "command" ? "Command" : "Patch"} ${source}.`);
    void this.deps.backend.resolveApproval(ap.id, decision, trust).catch((err) => this.pushNotice("error", `Approval failed: ${err instanceof Error ? err.message : String(err)}`));
    this.requestPaint(true);
  }

  // ── State + painting ───────────────────────────────────────────────────────

  private applyEvent(event: TerminalEvent): void {
    this.term = reduce(this.term, event, this.now);
    this.requestPaint(false);
  }

  private pushNotice(level: "info" | "warn" | "error", text: string): void {
    this.term = reduce(this.term, { type: "notice", level, text }, this.now);
  }

  private requestPaint(force: boolean): void {
    if (!this.active) return;
    const since = this.now() - this.lastPaintAt;
    if (force && since >= this.minIntervalMs) return void this.paint();
    if (this.timer) return;
    const delay = Math.max(0, this.minIntervalMs - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.paint();
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private fullRepaint(): void {
    const { io } = this.deps;
    if (io.isTTY) io.write("\x1b[2J" + HOME);
    this.paint();
  }

  /** Compose and write the frame, position the caret, manage cursor visibility. */
  private paint(): void {
    if (!this.active) return;
    this.lastPaintAt = this.now();
    const { io, out, unicode } = this.deps;
    const promptLabel = out.green(unicode ? "› " : "> ");
    const frame = composeApp(this.term, this.input, out, unicode, this.keyCtx, {
      columns: io.columns,
      rows: io.rows,
      tick: this.tick,
      ...(this.busy ? { elapsedMs: this.now() - this.streamStart } : {}),
      promptLabel,
      promptWidth: 2,
    });

    const lines = this.pendingApproval ? this.approvalFrameLines() : this.input.overlay === "output" ? this.outputFrameLines() : frame.lines;
    if (!io.isTTY) {
      io.write(lines.join("\n") + "\n");
      return;
    }
    const body = lines.map((l) => l + CLEAR_EOL).join("\r\n");
    let out2 = CURSOR_HIDE + HOME + body + CLEAR_BELOW;
    if (!this.busy && !this.pendingApproval) {
      // Place a real caret in the input area and show it.
      out2 += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H` + CURSOR_SHOW;
    }
    io.write(out2);
  }

  private approvalFrameLines(): string[] {
    const ap = this.pendingApproval!;
    const out = this.deps.out;
    const lines: string[] = [];
    for (const l of this.composeBaseLines()) lines.push(l);
    lines.push("");
    if (ap.kind === "command") {
      const d = ap.details as any;
      lines.push(out.bold("  Command approval"));
      lines.push(`  ${out.gray("run:")} ${d.executable} ${(d.args ?? []).join(" ")}`);
      lines.push(`  ${out.gray("why:")} ${d.purpose ?? "(not specified)"}  ${out.gray("risk:")} ${d.risk ?? "?"}`);
      lines.push(out.yellow("  [y] approve   [n] deny   [t] trust this command"));
    } else {
      const d = ap.details as any;
      lines.push(out.bold("  Patch approval"));
      lines.push(`  ${out.gray("files:")} ${(d.files ?? []).join(", ")}`);
      lines.push(`  ${out.gray("why:")} ${d.explanation ?? ""}`);
      lines.push(out.yellow("  [y] apply   [n] deny"));
    }
    return lines;
  }

  private outputFrameLines(): string[] {
    const out = this.deps.out;
    const viewer = this.outputViewer;
    if (!viewer) return this.composeBaseLines();
    const limit = Math.max(4, this.deps.io.rows - 6);
    return [out.bold(`  Output · ${viewer.title}`), out.gray("  Esc closes · output retained in task record"), "", ...viewer.lines.slice(-limit)];
  }

  private composeBaseLines(): string[] {
    const { io, out, unicode } = this.deps;
    return composeApp(this.term, this.input, out, unicode, this.keyCtx, {
      columns: io.columns,
      rows: io.rows,
      tick: this.tick,
      promptLabel: out.green(unicode ? "› " : "> "),
      promptWidth: 2,
    }).lines.slice(0, -2); // drop the input + footer; the approval panel replaces them
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private exit(): void {
    this.teardown();
    this.resolveDone?.();
    this.resolveDone = null;
  }

  /** Restore the terminal. Idempotent; safe from an exit handler. */
  teardown(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    if (this.streamAbort) this.streamAbort.abort();
    const { io, stdin } = this.deps;
    io.off("resize", this.onResize);
    stdin.removeListener("keypress", this.onKey);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    stdin.pause();
    process.removeListener("exit", this.onExit);
    if (io.isTTY) io.write(PASTE_OFF + CURSOR_SHOW + ALT_LEAVE);
  }

  // Test accessors.
  snapshot(): TerminalState {
    return this.term;
  }
  inputSnapshot(): InputState {
    return this.input;
  }
}
