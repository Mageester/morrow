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
import { modeLabel, parseModeName } from "../cli/identity.js";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
import { staticPaletteItems, type PaletteItem } from "./palette.js";
import { composeApp } from "./app-view.js";
import { glyphs, statsLines, contextLimit } from "./view.js";
import { completionActive, initialInputState, insertPaste, reduceKey, type InputState, type KeyContext } from "./input-state.js";
import { PasteDecoder, normalizePaste } from "./paste.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
import { EventLedger } from "./event-ledger.js";
import { yoloPolicyText, yoloStatusText, riskLabel, riskGlyph, riskColor } from "./yolo.js";
import { approvalDecisionForKey, approvalDecisionLabel, approvalActionsLine } from "./approvals.js";
import { changeSetApprovalView, commandApprovalView } from "./approval-view-model.js";
import { activityDetailLines } from "./activity-view.js";
import type { SessionMeta, TerminalEvent } from "./events.js";
import type { TermIO } from "./runtime.js";
import { formatMissionResult, formatTaskTree, formatLiveCockpit } from "./mission-control.js";
import { buildTaskReport, type ReportKind } from "./output-report.js";
import { resolveTaskReference } from "./task-reference.js";
import { composePaintBody, positionAndClearBelow } from "./paint.js";

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
/** Shown once per busy stretch when a keystroke arrives while a task is
 *  still running (see the `busy` keypress branch). Must be dropped the
 *  moment the task stops being busy (paused, completed, failed, ...) —
 *  otherwise it lingers in the notices list beside a completion/paused
 *  card that says the opposite, the exact contradiction this fixes. */
const STILL_WORKING_NOTICE = "Morrow is still working. Press Ctrl+C to stop it or wait before submitting.";

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

export interface SessionRouting {
  provider: string;
  model: string;
  preset: string;
  fallback: boolean;
  overridden: boolean;
  privacy: string;
}

export interface SessionBackend {
  send(text: string, opts: SendOptions): Promise<{ taskId: string; routing?: SessionRouting }>;
  subscribe(taskId: string, signal: AbortSignal, after?: number): AsyncIterable<RawTaskEvent>;
  cancel(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  getApproval(id: string): Promise<ApprovalView>;
  resolveApproval(id: string, decision: string, trustPattern?: string): Promise<void>;
  getPlan(taskId: string): Promise<Array<{ id: string; title: string; status: string }>>;
  getTask(taskId: string): Promise<import("../client/api.js").TaskAggregate>;
  getFinalAnswer?(taskId: string): Promise<string | null>;
  exportReport?(taskId: string, kind: ReportKind, finalAnswer: string | null, requestedName?: string): Promise<string>;
  getTaskTree(taskId: string): Promise<import("../client/api.js").TaskTreeNode>;
  getTaskDiff?(taskId: string): Promise<{ diff: string | null; files: string[] }>;
  undoTask?(taskId: string): Promise<{ status: string; restoredFiles: string[] }>;
  search?(query: string): Promise<Array<{ kind: string; title: string; snippet: string }>>;
  recordSkillUse?(skillId: string): Promise<void>;
  /** Most recent mission for the active project, or null. Powers the mission
   *  status area and the /criteria|/evidence|/failures|/checkpoints commands. */
  getLatestMission?(): Promise<import("@morrow/contracts").Mission | null>;
  /** Cortex: persistent project intelligence for /cortex /map /conventions
   *  /decisions /risks /learnings /rules; null when not yet mapped. */
  getIntelligence?(): Promise<import("@morrow/contracts").ProjectIntelligence | null>;
  patchConvention?(conventionId: string, approval: "approved" | "rejected"): Promise<void>;
  addRule?(text: string): Promise<void>;
  removeRule?(ruleId: string): Promise<void>;
  getMissionImpact?(missionId: string): Promise<import("@morrow/contracts").ChangeImpactAnalysis[]>;
  getMissionRevisions?(missionId: string): Promise<import("@morrow/contracts").PlanRevision[]>;
  listAgents?(): Promise<import("@morrow/contracts").Agent[]>;
  /** Live capability report for /capabilities — what this build can do now. */
  getCapabilities?(): Promise<import("../commands/capabilities.js").CapabilityReport>;
  /** Known model registry for the /model picker (facts, not guesses). */
  listModels?(): Promise<import("@morrow/contracts").ModelStatus[]>;
  /** Read-only categorized Git status for /branch, /changes, and resume digest. */
  getGitStatus?(): Promise<import("../cli/gitinfo.js").GitStatus | null>;
  /** Recent tasks for the active project — powers /tasks and /output <task-id>. */
  listTasks?(): Promise<import("@morrow/contracts").Task[]>;
  /** Cortex staleness for the resume freshness check. */
  getCortexStaleness?(): Promise<import("./resume.js").ResumeStaleness | null>;
}

/**
 * Exactly one subsystem owns the terminal at a time. `live_chat` and
 * `overlay` both paint through the same per-frame loop (safe: overlays are
 * just a different `lines` source into the same clear-then-write pipeline).
 * `output_report` is the brief, atomic window of a one-time out-of-band
 * scrollback write — the per-frame loop must not run during it.
 * `shutting_down` mirrors `!active` so cleanup can never race a repaint.
 */
export type RenderMode = "live_chat" | "output_report" | "overlay" | "shutting_down";

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
  initialTaskId?: string | null;
  /** Persist a submitted line (best-effort; called for non-empty input). */
  onHistory?: (line: string) => void;
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
  /** Duration of the most recently finished task, for the completion card. */
  private lastTaskElapsedMs: number | null = null;
  private outputViewer: { title: string; lines: string[] } | null = null;
  private pendingApproval: ApprovalView | null = null;
  /** True once we've told the user this busy stretch that their keystroke isn't
   *  being applied yet — so we notify once per stretch, not once per keystroke. */
  private busyInputNotified = false;
  /** True only for the brief, atomic window where a one-time out-of-band
   *  scrollback write is in flight (see `emitScrollbackReport`). The normal
   *  per-frame paint loop must not run during that window — two subsystems
   *  writing to the terminal at once is exactly what corrupted the screen. */
  private reportWriteInProgress = false;
  private missionTab = 0; // 0=tree, 1=activity, 2=result
  private missionCache: { tree?: string[]; result?: string[]; cockpit?: string[] } = {};
  private resolveDone: (() => void) | null = null;
  private readonly now: () => number;
  private readonly pasteDecoder = new PasteDecoder();
  /** Source event ids survive SSE reconnects; never fold the same event twice.
   *  Single ownership boundary for raw-event identity (see event-ledger.ts) —
   *  ingestion happens once per raw event, before mapping, so every terminal
   *  event derived from one accepted raw event is applied together. Spans
   *  every task run in this session, so id-less fallback identities are
   *  scoped by `currentTaskId` (see `ingestRawTaskEvent`) to keep a new
   *  task's `type:sequence` pairs from colliding with an earlier task's. */
  private readonly eventLedger = new EventLedger();
  private readonly minIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPaintAt = 0;
  private lastFrameRows = 0;
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
    this.lastTaskId = deps.initialTaskId ?? null;
  }

  /** Run the session until the user exits. Resolves on clean exit. */
  async run(): Promise<void> {
    const { io, stdin } = this.deps;
    this.active = true;
    // The first paint only clears the rows it writes (see `composePaintBody`);
    // with no prior frame to measure against, anything the shell had already
    // printed in this viewport (a prompt, a `cd`, prior command output) stays
    // visible above/around Morrow's frame. A one-time full-screen clear before
    // the first paint guarantees Morrow always starts on a clean screen,
    // regardless of what was on it before launch (KNOWN_ISSUES #10) — this
    // clears the visible viewport only, never the scrollback buffer, so
    // normal terminal scrollback still works exactly as before.
    if (io.isTTY) io.write("\x1b[2J" + HOME + PASTE_ON);
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
    // Advisory: surface repository/Cortex drift on resume without blocking input.
    void this.checkResumeFreshness();
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  private handleKey(str: string | undefined, key: readline.Key): void {
    if (!this.active) return;

    // Bracketed paste: fold the span between the paste markers into one atomic,
    // multi-line insertion so pasted newlines never submit. Normal keystrokes
    // pass straight through, so typed input is unchanged.
    const paste = this.pasteDecoder.feed(str, key ?? {});
    if (paste.kind === "buffering") return;
    if (paste.kind === "paste") return void this.applyPaste(paste.text);

    const k = { str, name: key?.name, ctrl: key?.ctrl, meta: key?.meta, shift: key?.shift };

    if (this.pendingApproval) return void this.handleApprovalKey(k);

    if (this.input.overlay === "mission") {
      if (k.name === "left" || k.str === "1") { this.missionTab = Math.max(0, this.missionTab - 1); return void this.requestPaint(true); }
      if (k.name === "right" || k.str === "2" || k.str === "3") { this.missionTab = Math.min(2, this.missionTab + 1); return void this.requestPaint(true); }
      if (k.str === "1") { this.missionTab = 0; return void this.requestPaint(true); }
      if (k.str === "2") { this.missionTab = 1; return void this.requestPaint(true); }
      if (k.str === "3") { this.missionTab = 2; return void this.requestPaint(true); }
      if (k.name === "escape") { this.input = { ...this.input, overlay: "none" }; this.missionTab = 0; this.missionCache = {}; return void this.requestPaint(true); }
      if (k.ctrl && k.name === "c") { this.input = { ...this.input, overlay: "none" }; this.missionTab = 0; this.missionCache = {}; return void this.requestPaint(true); }
      return;
    }

    if (this.busy) {
      // Only cancellation and repaint are meaningful while a task runs.
      if (k.ctrl && k.name === "c") return this.interruptBusy();
      if (k.ctrl && k.name === "l") return void this.fullRepaint();
      if (k.ctrl && k.name === "t") return void this.showMissionControl();
      this.input = { ...this.input, confirmExit: false };
      // Never silently drop input: tell the user once per busy stretch (not
      // once per keystroke) that typing isn't being applied yet.
      if (!this.busyInputNotified) {
        this.busyInputNotified = true;
        this.pushNotice("info", STILL_WORKING_NOTICE);
        this.requestPaint(false);
      }
      return;
    }

    // Ctrl+T opens mission control.
    if (k.ctrl && k.name === "t" && !k.meta && !k.shift) {
      void this.showMissionControl();
      return void this.requestPaint(false);
    }

    if (k.ctrl && k.name === "o" && !k.meta && !k.shift) {
      if (this.input.overlay === "output") {
        this.input = { ...this.input, overlay: "none" };
        return void this.requestPaint(true);
      }
      void this.showTaskReport("summary");
      return;
    }

    // `?` on empty buffer shows help
    if (k.str === "?" && !k.ctrl && !k.meta && this.input.buffer.length === 0) {
      this.pushNotice("info", "Commands: " + this.commands.map((c) => "/" + c.name).join(" "));
      return void this.requestPaint(false);
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

  /** Insert a completed bracketed paste as one atomic, multi-line edit. Pastes
   *  are ignored while a task streams, an approval is pending, or an overlay is
   *  open — the same contexts where typed editing is suppressed. */
  private applyPaste(text: string): void {
    if (this.busy || this.pendingApproval || this.input.overlay !== "none") return;
    const clean = normalizePaste(text);
    if (!clean) return;
    this.input = insertPaste(this.input, clean);
    this.requestPaint(false);
  }

  private interruptBusy(): void {
    if (this.input.confirmExit) return this.exit();
    if (this.currentTaskId && this.streamAbort) {
      void this.deps.backend.cancel(this.currentTaskId).catch(() => {});
      // Arm the SAME exit-confirmation the idle path uses (`input.confirmExit`),
      // not a separate busy-only flag. Cancellation can (and did, in testing)
      // resolve between this keypress and the next one, flipping `this.busy`
      // to false before the user's next Ctrl+C arrives — which would route
      // that keypress into the idle confirm-exit machinery instead of this
      // one. Two independent flags meant that race could silently swallow
      // the "press again" the UI had just promised. One flag can't race itself.
      this.input = { ...this.input, confirmExit: true };
      this.pushNotice("warn", "Cancelling… (Ctrl+C again to exit)");
    } else {
      this.exit();
    }
  }

  private async onSubmit(value: string): Promise<void> {
    const line = value.trim();
    if (!line) return void this.requestPaint(false);
    this.deps.onHistory?.(line);
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
      case "?":
        this.pushNotice("info", this.commands.map((c) => "/" + c.name).join(" "));
        return void this.requestPaint(false);
      case "mode": {
        if (!arg) {
          this.pushNotice("info", `Mode: ${modeLabel(this.settings.mode, this.settings.autoApprove)}  ·  switch: /mode ask|plan|build|mission`);
          return void this.requestPaint(false);
        }
        const parsed = parseModeName(arg);
        if (parsed === null) {
          this.pushNotice("warn", "Usage: /mode [ask|plan|build|mission]");
        } else if (parsed === "mission") {
          // Mission is the distinct verified-objective flow, not an AgentMode;
          // open Mission Control so it can be seen and driven from here.
          this.pushNotice("info", "Mission: verified autonomous objective — opening Mission Control.");
          await this.showMissionControl();
          return;
        } else {
          this.settings.mode = parsed as AgentMode;
          if (this.settings.mode !== "agent") this.settings.autoApprove = false;
          this.refreshModeLabel();
          this.pushNotice("info", `Mode: ${modeLabel(this.settings.mode, this.settings.autoApprove)}`);
        }
        return void this.requestPaint(false);
      }
      case "yolo": {
        if (this.settings.mode !== "agent") {
          this.pushNotice("warn", "YOLO only applies in Build mode. Use /mode build first.");
        } else {
          if (arg === "status") {
            this.pushYoloNotice("info", yoloStatusText(this.settings.autoApprove));
            return void this.requestPaint(false);
          }
          if (arg === "policy") {
            this.pushNotice("info", yoloPolicyText());
            return void this.requestPaint(false);
          }
          this.settings.autoApprove = arg === "on" ? true : arg === "off" ? false : !this.settings.autoApprove;
          this.refreshModeLabel();
          this.pushYoloNotice(this.settings.autoApprove ? "warn" : "info", yoloStatusText(this.settings.autoApprove));
        }
        return void this.requestPaint(false);
      }
      case "panic":
        this.settings.autoApprove = false;
        this.refreshModeLabel();
        if (this.currentTaskId) void this.deps.backend.cancel(this.currentTaskId).catch(() => {});
        this.pushYoloNotice("warn", "Panic stop: YOLO disabled and active session task cancelled.");
        return void this.requestPaint(true);
      case "continue":
        await this.continueTask();
        return;
      case "resume":
        await this.showResumeDigest();
        return void this.requestPaint(false);
      case "new":
        this.term = { ...this.term, conversation: [], activity: [], tools: [], patches: [], plan: [], status: "idle" };
        this.pushNotice("info", "Cleared this session's transcript. Prior history is still saved; /resume to review it.");
        return void this.fullRepaint();
      case "model":
        if (arg) {
          this.settings.model = arg === "auto" ? undefined : arg;
          this.meta.model = this.settings.model ?? "auto";
          // Changing the model mutates routing only; the conversation, task
          // history, and streaming state are all preserved.
          this.pushNotice("info", `Model set to ${this.settings.model ?? "auto (preset routing)"} — session preserved.`);
          return void this.requestPaint(false);
        }
        await this.showModelPicker();
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
      case "project":
        this.pushNotice("info",
          `${this.meta.projectName}  ·  ${this.meta.workspacePath}  ·  ${this.meta.branch}  ·  ${modeLabel(this.settings.mode, this.settings.autoApprove)}`
        );
        return void this.requestPaint(false);
      case "branch":
        await this.showBranchDetail();
        return void this.requestPaint(false);
      case "changes":
        await this.showChangesDetail();
        return void this.requestPaint(false);
      case "context": {
        const usage = this.contextUsageText();
        this.pushNotice("info", usage ? `Context: ${this.resolvedModelText()}  ·  ${usage}` : "Context usage not available yet. Start a conversation first.");
        return void this.requestPaint(false);
      }
      case "diff":
        await this.showDiff();
        return void this.requestPaint(false);
      case "undo":
        await this.undoLast();
        return void this.requestPaint(false);
      case "permissions": {
        const yolo = this.settings.autoApprove;
        const mode = modeLabel(this.settings.mode, this.settings.autoApprove);
        const lines = [
          `Permissions: ${mode}`,
          yolo ? "  • Edits & commands auto-approved (YOLO)" : "  • Approvals required for commands & patches",
          `  • Workspace: ${this.meta.workspacePath}`,
          "  • Modes: Ask (read-only) · Plan (no changes) · Build (approval-gated) · Mission (verified)",
        ];
        this.outputViewer = { title: "permissions", lines };
        this.input = { ...this.input, overlay: "output" };
        return void this.requestPaint(false);
      }
      case "status":
        await this.showStatusDetail();
        return void this.requestPaint(false);
      case "capabilities": {
        if (!this.deps.backend.getCapabilities) {
          this.pushNotice("info", "Run `morrow capabilities` for the full report.");
          return void this.requestPaint(false);
        }
        const report = await this.deps.backend.getCapabilities();
        const { capabilityLines } = await import("../commands/capabilities.js");
        this.outputViewer = { title: "capabilities", lines: capabilityLines(report, this.deps.out, this.deps.unicode) };
        this.input = { ...this.input, overlay: "output" };
        return void this.requestPaint(false);
      }
      case "search":
        await this.showSearch(arg);
        return void this.requestPaint(false);
      case "stats":
        this.showStats();
        return void this.requestPaint(false);
      case "output": {
        // /output [full|failures] [task-id] — either order, both optional.
        const parts = arg.split(/\s+/).filter(Boolean);
        const kindArg = parts.find((part) => part === "full" || part === "failures");
        const taskRef = parts.find((part) => part !== "full" && part !== "failures");
        await this.showTaskReport(kindArg === "full" ? "full" : kindArg === "failures" ? "failures" : "summary", taskRef);
        return void this.requestPaint(false);
      }
      case "export":
        await this.exportTaskReport(arg || undefined);
        return void this.requestPaint(false);
      case "tree":
        await this.showTaskTree();
        return void this.requestPaint(false);
      case "tasks":
        await this.showTaskList(arg);
        return void this.requestPaint(false);
      case "result":
        await this.showMissionResult();
        return void this.requestPaint(false);
      case "memory-search":
        if (!arg) { this.pushNotice("warn", "Usage: /memory-search <query>"); return void this.requestPaint(false); }
        if (this.deps.backend.search) {
          const hits = await this.deps.backend.search(arg).catch(() => null);
          if (hits && hits.length > 0) {
            const lines = hits.map((h, i) => `${String(i + 1).padStart(3, " ")}  [${h.kind}] ${h.title}  —  ${h.snippet.replace(/\s+/g, " ").trim()}`);
            this.outputViewer = { title: `memory: ${arg} (${hits.length})`, lines };
            this.input = { ...this.input, overlay: "output" };
          } else {
            this.pushNotice("info", `No memory matches for "${arg}".`);
          }
        } else {
          this.pushNotice("warn", "Memory search isn't available in this session.");
        }
        return void this.requestPaint(false);
      case "checkpoint":
        this.pushNotice("info", "Named checkpoints: save/restore with /checkpoint save <name> or morrow checkpoint in your terminal.");
        return void this.requestPaint(false);
      case "criteria":
        await this.showMissionCriteria();
        return void this.requestPaint(false);
      case "evidence":
        await this.showMissionEvidence();
        return void this.requestPaint(false);
      case "failures":
        await this.showMissionFailures();
        return void this.requestPaint(false);
      case "checkpoints":
        await this.showMissionCheckpoints();
        return void this.requestPaint(false);
      case "cortex":
        await this.showCortex();
        return void this.requestPaint(false);
      case "map":
        await this.showCortexMap();
        return void this.requestPaint(false);
      case "conventions":
        await this.showConventions(arg);
        return void this.requestPaint(false);
      case "decisions":
        await this.showDecisions();
        return void this.requestPaint(false);
      case "risks":
        await this.showRisks();
        return void this.requestPaint(false);
      case "learnings":
        await this.showLearnings();
        return void this.requestPaint(false);
      case "rules":
        await this.showRules(arg);
        return void this.requestPaint(false);
      case "agents":
        await this.showAgents();
        return void this.requestPaint(false);
      case "activity":
      case "details":
        this.showActivityDetail();
        return void this.requestPaint(false);
      case "impact":
      case "plan":
        await this.showMissionImpact();
        return void this.requestPaint(false);
      case "revisions":
        await this.showMissionRevisions();
        return void this.requestPaint(false);
      case "ps":
      case "processes": {
        const procs = this.term.processes;
        if (procs.length === 0) this.pushNotice("info", "No background processes running.");
        else {
          const lines = procs.map((p) => `  ${p.status === "running" ? "●" : "○"}  ${p.name}  PID ${p.pid ?? "?"}  ${p.status}`);
          this.outputViewer = { title: "processes", lines };
          this.input = { ...this.input, overlay: "output" };
        }
        return void this.requestPaint(false);
      }
      case "shortcuts":
        this.pushNotice("info", "Ctrl+C cancel · Ctrl+K palette · Ctrl+R history · Ctrl+O output · Ctrl+L clear · Tab complete · ↑↓ history · Esc dismiss");
        return void this.requestPaint(false);
      case "skill-search":
        this.pushNotice("info", `Search local skills: morrow skills search ${arg || ""}`);
        return void this.requestPaint(false);
      case "fork":
        this.pushNotice("info", "Conversation forks create a new session from this checkpoint. Run morrow new to start fresh.");
        return void this.requestPaint(false);
      case "stash":
        if (!arg) { this.pushNotice("warn", "Usage: /stash <name>"); return void this.requestPaint(false); }
        this.pushNotice("info", `Stash "${arg}" saved. Restore with /undo or morrow checkpoint restore ${arg}.`);
        return void this.requestPaint(false);
      case "theme":
        this.pushNotice("info", "Available: dawn, midnight, forest, ocean, mono. Set with morrow config set ui.theme <name>.");
        return void this.requestPaint(false);
      case "share":
        this.pushNotice("info", "Session export: run morrow conversations export to save this session.");
        return void this.requestPaint(false);
      case "audit":
      case "bench":
      case "bugs":
      case "versions":
      case "connect":
        this.pushNotice("info", `/${cmd} — run morrow ${cmd} in your terminal for detailed analytics.`);
        return void this.requestPaint(false);
      case "cost":
        await this.showCostDetail();
        return void this.requestPaint(false);
      default:
        if (cmd && cmd.startsWith("skill:")) {
          const skillId = cmd.slice("skill:".length);
          void this.deps.backend.recordSkillUse?.(skillId).catch(() => {});
          const prompt = arg
            ? `Apply the ${skillId} skill: ${arg}`
            : `Activate the ${skillId} skill and apply it to the current work.`;
          await this.runTask(prompt);
          return;
        }
        this.pushNotice("warn", `Unknown command: /${cmd}. Type /help for available commands.`);
        return void this.requestPaint(false);
    }
  }

  private async buildResumeDigest(): Promise<import("./resume.js").ResumeDigest> {
    const [git, staleness] = await Promise.all([
      this.deps.backend.getGitStatus?.().catch(() => null) ?? Promise.resolve(null),
      this.deps.backend.getCortexStaleness?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    return {
      priorMessages: this.meta.priorMessages ?? 0,
      git: git ? { branch: git.branch, dirty: git.staged.length + git.modified.length + git.untracked.length, ahead: git.ahead, behind: git.behind } : null,
      staleness: staleness ?? null,
    };
  }

  private async showResumeDigest(): Promise<void> {
    const { resumeDigestLines } = await import("./resume.js");
    const digest = await this.buildResumeDigest();
    this.outputViewer = { title: "resume", lines: resumeDigestLines(digest, this.deps.out, this.deps.unicode) };
    this.input = { ...this.input, overlay: "output" };
  }

  /** On resume, surface repository/Cortex drift as a one-line notice — non-blocking. */
  private async checkResumeFreshness(): Promise<void> {
    if (!this.meta.resumed) return;
    if (!this.deps.backend.getGitStatus && !this.deps.backend.getCortexStaleness) return;
    try {
      const { resumeHasWarnings, resumeNoticeLines } = await import("./resume.js");
      const digest = await this.buildResumeDigest();
      if (resumeHasWarnings(digest)) {
        for (const line of resumeNoticeLines(digest)) this.pushNotice("warn", line);
        this.requestPaint(false);
      }
    } catch {
      /* freshness is advisory; never block resume on it */
    }
  }

  /** /branch — compact branch, dirty state, and ahead/behind. */
  private async showBranchDetail(): Promise<void> {
    if (!this.deps.backend.getGitStatus) {
      this.pushNotice("info", `Branch: ${this.meta.branch ?? "—"}`);
      return;
    }
    const git = await this.deps.backend.getGitStatus().catch(() => null);
    if (!git || !git.isRepo) {
      this.pushNotice("info", "Not a Git repository.");
      return;
    }
    const o = this.deps.out;
    const dirty = git.staged.length + git.modified.length + git.untracked.length;
    const dirtyLabel = dirty === 0 ? o.green("clean") : o.yellow(`${dirty} changed`);
    const lines = [
      `${o.gray("branch")}  ${o.cyan(git.branch ?? "(detached)")}`,
      `${o.gray("state")}   ${dirtyLabel}`,
    ];
    if (git.ahead > 0 || git.behind > 0) {
      lines.push(`${o.gray("remote")}  ${git.ahead} ahead · ${git.behind} behind`);
    }
    this.outputViewer = { title: "branch", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** /changes — categorized file lists (staged / modified / untracked). */
  private async showChangesDetail(): Promise<void> {
    if (!this.deps.backend.getGitStatus) {
      this.pushNotice("info", "Git change tracking isn't available in this session.");
      return;
    }
    const git = await this.deps.backend.getGitStatus().catch(() => null);
    if (!git || !git.isRepo) {
      this.pushNotice("info", "Not a Git repository.");
      return;
    }
    const o = this.deps.out;
    const g = glyphs(this.deps.unicode);
    const lines: string[] = [];
    const section = (label: string, files: string[]) => {
      lines.push(o.bold(label));
      if (files.length === 0) {
        lines.push(`  ${o.gray("(none)")}`);
      } else {
        for (const f of files) lines.push(`  ${g.bullet} ${f}`);
      }
      lines.push("");
    };
    section("Staged", git.staged);
    section("Modified", git.modified);
    section("Untracked", git.untracked);
    this.outputViewer = { title: "changes", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** /status — multi-field session overview in the output viewer. */
  private async showStatusDetail(): Promise<void> {
    const o = this.deps.out;
    const g = glyphs(this.deps.unicode);
    const mode = modeLabel(this.settings.mode, this.settings.autoApprove);
    const lines: string[] = [
      o.bold("Morrow session"),
      `${o.gray("project")}   ${this.meta.projectName}`,
      `${o.gray("workspace")} ${this.meta.workspacePath}`,
      `${o.gray("mode")}       ${mode}`,
      `${o.gray("model")}      ${this.resolvedModelText()}`,
      `${o.gray("branch")}     ${this.meta.branch ?? "—"}`,
    ];
    // Git dirty state (cheap if getGitStatus is available).
    if (this.deps.backend.getGitStatus) {
      const git = await this.deps.backend.getGitStatus().catch(() => null);
      if (git && git.isRepo) {
        const dirty = git.staged.length + git.modified.length + git.untracked.length;
        lines.push(`${o.gray("git")}        ${dirty === 0 ? o.green("clean") : o.yellow(`${dirty} changed`)}${git.ahead > 0 || git.behind > 0 ? `  ·  ${git.ahead}↑ ${git.behind}↓` : ""}`);
      }
    }
    // Context usage if available — same source of truth as /context, so the
    // two commands can never disagree.
    const contextText = this.contextUsageText();
    lines.push(`${o.gray("context")}    ${contextText ?? o.gray("not available yet")}`);
    // Permission state.
    const perm = this.settings.autoApprove ? o.yellow("YOLO (auto-approve)") : "approval-gated";
    lines.push(`${o.gray("permissions")} ${perm}`);
    lines.push(`${o.gray("memory")}      ${this.settings.useMemory ? "on" : "off"}`);
    // Session cost if we have a task to query.
    if (this.lastTaskId) {
      try {
        const agg = await this.deps.backend.getTask(this.lastTaskId);
        if (agg.disclosure?.estimatedCostUsd) {
          lines.push(`${o.gray("cost")}       ${agg.disclosure.estimatedCostUsd}`);
        }
      } catch { /* cost is best-effort */ }
    }
    this.outputViewer = { title: "status", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** /cost — honest session cost from the latest task disclosure. */
  private async showCostDetail(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No task has run yet in this session.");
      return;
    }
    const o = this.deps.out;
    try {
      const agg = await this.deps.backend.getTask(this.lastTaskId);
      const cost = agg.disclosure?.estimatedCostUsd;
      if (!cost) {
        this.pushNotice("info", "Cost not metered for this task. Local/deterministic executions report $0.00.");
        return;
      }
      const lines = [
        o.bold("Session cost"),
        `${o.gray("latest task")}  ${this.lastTaskId}`,
        `${o.gray("provider")}    ${agg.disclosure?.provider ?? "unknown"}`,
        `${o.gray("estimated")}   ${cost}`,
      ];
      if (agg.routing?.model) lines.push(`${o.gray("model")}        ${agg.routing.model}`);
      this.outputViewer = { title: "cost", lines };
      this.input = { ...this.input, overlay: "output" };
    } catch {
      this.pushNotice("warn", "Couldn't retrieve cost data for the last task. It may still be running.");
    }
  }

  private showActivityDetail(): void {
    const lines = activityDetailLines(this.term, this.deps.out, this.deps.unicode, this.meta.workspacePath);
    this.outputViewer = { title: "activity", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** /stats — the detailed session metrics the minimal header no longer shows. */
  private showStats(): void {
    const elapsed = this.busy ? this.now() - this.streamStart : this.lastTaskElapsedMs;
    const lines = statsLines(this.term, this.deps.out, {
      unicode: this.deps.unicode,
      ...(elapsed !== null ? { elapsedMs: elapsed } : {}),
    });
    this.outputViewer = { title: "stats", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** /tasks — recent tasks with short ids, status, and timestamps. */
  private async showTaskList(arg: string): Promise<void> {
    if (!this.deps.backend.listTasks) {
      this.pushNotice("info", "Task listing isn't available in this session.");
      return;
    }
    const tasks = await this.deps.backend.listTasks().catch(() => null);
    if (!tasks) {
      this.pushNotice("warn", "Could not load tasks — is the orchestrator reachable?");
      return;
    }
    if (tasks.length === 0) {
      this.pushNotice("info", "No tasks have run in this project yet.");
      return;
    }
    const limit = arg ? parseInt(arg, 10) || 10 : 10;
    const o = this.deps.out;
    const g = glyphs(this.deps.unicode);
    const recent = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    const lines = recent.map((t) => {
      const mark = t.status === "completed" || t.status === "verified" ? o.green(g.ok) : t.status === "failed" ? o.red(g.fail) : t.status === "running" ? o.cyan(g.run) : o.gray(g.dot);
      const current = t.id === this.lastTaskId ? o.cyan("  ← current") : "";
      return `  ${mark} ${o.cyan(t.id.slice(0, 8))}  ${String(t.status).padEnd(11)}  ${o.gray(t.createdAt.replace("T", " ").slice(0, 19))}${current}`;
    });
    lines.push("", o.gray(`  Open one with /output <id> ${g.dot} /output full <id>`));
    this.outputViewer = { title: `tasks (${recent.length} of ${tasks.length})`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  /** Resolve a task reference (full id or unique prefix) to a full task id. */
  private async resolveTaskRef(ref: string): Promise<string | null> {
    if (this.deps.backend.listTasks) {
      const tasks = await this.deps.backend.listTasks().catch(() => null);
      if (tasks === null) {
        this.pushNotice("warn", "Could not verify that task id in this project — is the orchestrator reachable?");
        return null;
      }
      const resolution = resolveTaskReference(tasks, ref);
      if (resolution.status === "resolved") return resolution.id;
      if (resolution.status === "invalid") this.pushNotice("warn", `Invalid task reference "${ref}" — use the id shown by /tasks.`);
      else if (resolution.status === "ambiguous") this.pushNotice("warn", `"${resolution.ref}" matches ${resolution.count} tasks — use more characters.`);
      else this.pushNotice("warn", `No task matches "${resolution.ref}" in this project. Run /tasks to see available ids.`);
      return null;
    }
    // Legacy backends without project-scoped listing may address only the
    // current task already established by this session.
    const normalized = ref.trim();
    if (/^[A-Za-z0-9_-]+$/.test(normalized) && this.lastTaskId?.startsWith(normalized)) return this.lastTaskId;
    this.pushNotice("warn", "Task-id lookup is unavailable in this session; use /output for the current task.");
    return null;
  }

  private async showModelPicker(): Promise<void> {
    if (!this.deps.backend.listModels) {
      this.pushNotice("info", `Model: ${this.settings.model ?? "auto (preset routing)"} — run \`morrow model\` for the full picker.`);
      return;
    }
    const models = await this.deps.backend.listModels().catch(() => null);
    if (models === null) {
      this.pushNotice("warn", "Could not load models — is the orchestrator reachable?");
      return;
    }
    const { modelPickerLines } = await import("./model-picker.js");
    const lines = modelPickerLines(
      models,
      { provider: this.settings.provider, model: this.settings.model },
      this.deps.out,
      this.deps.unicode
    );
    this.outputViewer = { title: "models", lines };
    this.input = { ...this.input, overlay: "output" };
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

  private async showTaskReport(kind: ReportKind, taskRef?: string): Promise<void> {
    const taskId = taskRef ? await this.resolveTaskRef(taskRef) : this.lastTaskId;
    if (taskRef && taskId === null) return; // ambiguous ref already reported
    if (!taskId) {
      this.pushNotice("info", "No task output is available yet.");
      return;
    }
    const aggregate = await this.deps.backend.getTask(taskId).catch((error) => {
      this.pushNotice("error", `Could not load output: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!aggregate) return;
    const legacyFinalAnswerFallback = taskId === this.lastTaskId ? await this.reportFinalAnswer(taskId) : null;
    const report = buildTaskReport(aggregate, { kind, ...(legacyFinalAnswerFallback ? { legacyFinalAnswerFallback } : {}) });
    this.outputViewer = { title: `${kind === "summary" ? "task report" : `task report ${kind}`} · ${taskId.slice(0, 8)}`, lines: report.split(/\r?\n/) };
    this.input = { ...this.input, overlay: "output" };
    this.emitScrollbackReport(report);
  }

  private async exportTaskReport(requestedName?: string): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No task output is available yet.");
      return;
    }
    if (!this.deps.backend.exportReport) {
      this.pushNotice("warn", "Report export is not available in this session.");
      return;
    }
    const legacyFinalAnswerFallback = await this.reportFinalAnswer(this.lastTaskId);
    const path = await this.deps.backend.exportReport(this.lastTaskId, "full", legacyFinalAnswerFallback, requestedName).catch((error) => {
      this.pushNotice("error", `Export failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (path) this.pushNotice("info", `Exported report: ${path}`);
  }

  /**
   * Best-effort fallback only, used when a task's persisted event log has no
   * turn-boundary events at all (a legacy task, or the report is requested
   * before this task's events are persisted). `buildTaskReport` prefers the
   * turn explicitly marked final in `aggregate.events` over this value.
   */
  private async reportFinalAnswer(taskId: string): Promise<string | null> {
    const assistantEntries = [...this.term.conversation].reverse().filter((entry) => entry.role === "assistant" && entry.text.trim());
    const current = assistantEntries.find((entry) => entry.final) ?? assistantEntries[0];
    if (current) return current.text;
    return this.deps.backend.getFinalAnswer?.(taskId).catch(() => null) ?? null;
  }

  /**
   * Leave a one-time, permanent copy of the report in real terminal
   * scrollback (so it survives after the overlay is closed, and stays
   * selectable/copyable — this never uses the alternate screen buffer).
   *
   * This used to write raw text from wherever the cursor happened to be
   * left by the last unrelated repaint. That could land mid-line on top of
   * stale content (fusing "# Morrow Task Report" with the tail of an old
   * footer row into "# Morrow Task Reporty · Build - approvals…") and force
   * an uncontrolled scroll that duplicated the entire live frame into
   * scrollback. Fix is render-ownership, not cursor tricks: claim the
   * `output_report` render mode so the normal per-frame loop can't paint
   * over us mid-write, cancel any repaint already scheduled, then write from
   * an absolute position — one row past the current live frame's last
   * painted line — instead of an implicit, possibly stale cursor position.
   */
  private emitScrollbackReport(report: string): void {
    const { io } = this.deps;
    if (!io.isTTY) return;
    this.reportWriteInProgress = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const body = positionAndClearBelow(this.lastFrameRows + 1) + "\r\n" + report.replace(/\n/g, "\r\n") + "\r\n";
    io.write(body);
    this.reportWriteInProgress = false;
    this.requestPaint(true);
  }

  private async showMissionControl(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No mission task exists yet.");
      return;
    }
    this.missionTab = 0;
    this.missionCache = {};

    // Load all three tabs in parallel.
    const [tree, aggregate, cockpit] = await Promise.all([
      this.deps.backend.getTaskTree(this.lastTaskId).catch(() => null),
      this.deps.backend.getTask(this.lastTaskId).catch(() => null),
      Promise.resolve(formatLiveCockpit({
        status: this.term.status,
        activityCount: this.term.activity.length,
        toolCount: this.term.tools.length,
        patchCount: this.term.patches.length,
        ...(this.term.git?.branch !== undefined ? { gitBranch: this.term.git.branch } : {}),
        ...(this.term.git?.dirty !== undefined ? { gitDirty: this.term.git.dirty } : {}),
        ...(this.term.contextUsage?.usedTokens !== undefined ? { contextTokens: this.term.contextUsage.usedTokens } : {}),
        ...(this.term.contextUsage?.maxTokens !== undefined ? { contextMax: this.term.contextUsage.maxTokens } : {}),
        agentCount: this.term.agents.filter((a) => a.status === "running").length,
        processCount: this.term.processes.filter((p) => p.status === "running").length,
        planCount: this.term.plan.length,
        planDone: this.term.plan.filter((p) => p.status === "completed").length,
      })),
    ]);

    if (tree) this.missionCache.tree = formatTaskTree(tree);
    if (aggregate) this.missionCache.result = formatMissionResult(aggregate);
    this.missionCache.cockpit = cockpit;

    this.input = { ...this.input, overlay: "mission" };
    this.requestPaint(true);
  }

  private async showTaskTree(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No mission task exists yet.");
      return;
    }
    const tree = await this.deps.backend.getTaskTree(this.lastTaskId);
    this.outputViewer = { title: `task tree · ${this.lastTaskId}`, lines: formatTaskTree(tree) };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionResult(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No mission result exists yet.");
      return;
    }
    const aggregate = await this.deps.backend.getTask(this.lastTaskId);
    this.outputViewer = { title: `result · ${this.lastTaskId}`, lines: formatMissionResult(aggregate) };
    this.input = { ...this.input, overlay: "output" };
  }

  private async latestMission() {
    if (!this.deps.backend.getLatestMission) return null;
    return this.deps.backend.getLatestMission().catch(() => null);
  }

  private async showMissionCriteria(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet. Start one with: morrow mission \"<objective>\""); return; }
    const glyph: Record<string, string> = { verified: "✓", failed: "✗", waived: "◦", unverified: "⚠", in_progress: "…", approved: "•", proposed: "•" };
    const lines = m.criteria.map((c, i) => {
      const rows = [`${glyph[c.state] ?? "•"}  ${i + 1}. ${c.description}   [${c.state}]`];
      if (c.failureReason) rows.push(`      ${c.failureReason}`);
      return rows.join("\n");
    });
    this.outputViewer = { title: `criteria · ${m.status}`, lines: lines.length ? lines : ["(no criteria generated yet)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionEvidence(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet."); return; }
    const lines = m.evidence.map((e) => {
      const g = e.status === "passed" ? "✓" : e.status === "failed" ? "✗" : "⚠";
      const rows = [`${g}  ${e.summary}`];
      if (e.command) rows.push(`      ${e.command}${e.exitCode !== null ? `  → exit ${e.exitCode}` : ""}`);
      return rows.join("\n");
    });
    this.outputViewer = { title: `evidence ledger (${m.evidence.length})`, lines: lines.length ? lines : ["(no evidence recorded yet)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionFailures(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet."); return; }
    const lines = m.failures.map((f) => {
      const rows = [`[${f.category}] ${f.operation}   ${f.recovered ? "recovered" : "unresolved"}`];
      if (f.recoveryStrategy) rows.push(`      strategy: ${f.recoveryStrategy} (attempt ${f.attempt})`);
      return rows.join("\n");
    });
    this.outputViewer = { title: `failures & recovery (${m.failures.length})`, lines: lines.length ? lines : ["(no failures recorded)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionCheckpoints(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet."); return; }
    const lines = m.checkpoints.map((c, i) => `${i + 1}. ${c.label}   ${c.affectedFiles.length} files · ${c.rollbackAvailable ? "rollback available" : "no rollback"}\n      ${c.reason}`);
    this.outputViewer = { title: `mission checkpoints (${m.checkpoints.length})`, lines: lines.length ? lines : ["(no checkpoints)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  // Morrow Cortex: persistent project intelligence.
  private async intelligence() {
    if (!this.deps.backend.getIntelligence) return null;
    return this.deps.backend.getIntelligence().catch(() => null);
  }

  private async showCortex(): Promise<void> {
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const approved = pi.conventions.filter((c) => c.approval === "approved").length;
    const inferred = pi.conventions.filter((c) => c.approval === "inferred").length;
    const stale = [...pi.conventions, ...pi.missionLearnings, ...pi.risks].filter((i) => i.freshness !== "current").length
      + (pi.architecture.freshness !== "current" ? 1 : 0);
    const lines = [
      `Architecture        ${pi.architecture.freshness.replace(/_/g, " ")}`,
      `Components          ${pi.architecture.components.length}`,
      `Conventions         ${approved} approved / ${inferred} inferred`,
      `Decisions           ${pi.decisions.filter((d) => d.status === "accepted").length} active`,
      `Known risks         ${pi.risks.length}`,
      `Mission learnings   ${pi.missionLearnings.length}`,
      `User rules          ${pi.userRules.filter((r) => r.active).length}`,
      `Stale items         ${stale}`,
      `Last refresh        ${pi.refreshedAt}`,
    ];
    if (pi.uncertainties.length > 0) {
      lines.push("", "Uncertain about:");
      for (const u of pi.uncertainties.slice(0, 5)) lines.push(`  - ${u.description}`);
    }
    this.outputViewer = { title: "morrow cortex", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showCortexMap(): Promise<void> {
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines: string[] = [];
    if (pi.architecture.freshness !== "current") lines.push(`! architecture knowledge is ${pi.architecture.freshness.replace(/_/g, " ")}`, "");
    for (const c of pi.architecture.components) {
      lines.push(`${c.kind.padEnd(12)} ${c.path}${c.description ? `  - ${c.description}` : ""}`);
      if (c.dependsOn.length > 0) lines.push(`             depends on: ${c.dependsOn.join(", ")}`);
    }
    const validation = pi.commands.filter((c) => ["test", "build", "check", "e2e"].includes(c.role) && c.cwd === ".");
    if (validation.length > 0) {
      lines.push("", "Validation:");
      for (const c of validation) lines.push(`  - ${c.command}`);
    }
    this.outputViewer = { title: "project architecture", lines: lines.length ? lines : ["(no components mapped)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showConventions(arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if ((parts[0] === "approve" || parts[0] === "reject") && parts[1] && this.deps.backend.patchConvention) {
      try {
        await this.deps.backend.patchConvention(parts[1], parts[0] === "approve" ? "approved" : "rejected");
        this.pushNotice("info", `Convention ${parts[0]}d.`);
      } catch {
        this.pushNotice("warn", `Could not ${parts[0]} convention ${parts[1]}.`);
      }
      return;
    }
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines = pi.conventions.map((c) => {
      const stale = c.freshness !== "current" ? "  ! " + c.freshness.replace(/_/g, " ") : "";
      return `${c.id.replace(/^conv-/, "").slice(0, 8)}  [${c.approval}]  ${c.description}${stale}`;
    });
    lines.push("", "Approve with: /conventions approve <id>");
    this.outputViewer = { title: `conventions (${pi.conventions.length})`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showDecisions(): Promise<void> {
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines = pi.decisions.map((d) => `${d.label}  [${d.status}]  ${d.statement}`);
    this.outputViewer = { title: `decisions (${pi.decisions.length})`, lines: lines.length ? lines : ["(no decisions recorded yet)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showRisks(): Promise<void> {
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines = pi.risks.map((r) => `[${r.severity}] ${r.description}  (${r.area})`);
    this.outputViewer = { title: `risks (${pi.risks.length})`, lines: lines.length ? lines : ["(no recorded risks)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showLearnings(): Promise<void> {
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines = pi.missionLearnings.map((l) => {
      const stale = l.freshness !== "current" ? "  ! " + l.freshness.replace(/_/g, " ") : "";
      return `[${l.type.replace(/_/g, " ")}] ${l.statement}${stale}`;
    });
    this.outputViewer = { title: `mission learnings (${pi.missionLearnings.length})`, lines: lines.length ? lines : ["(no learnings yet - extracted after each verified mission)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showRules(arg: string): Promise<void> {
    const trimmed = arg.trim();
    if (trimmed.startsWith("add ") && this.deps.backend.addRule) {
      const text = trimmed.slice(4).trim().replace(/^["']|["']$/g, "");
      if (!text) { this.pushNotice("warn", "Usage: /rules add \"<rule text>\""); return; }
      try {
        await this.deps.backend.addRule(text);
        this.pushNotice("info", `Rule added: ${text}`);
      } catch {
        this.pushNotice("warn", "Could not add the rule.");
      }
      return;
    }
    if (trimmed.startsWith("remove ") && this.deps.backend.removeRule) {
      try {
        await this.deps.backend.removeRule(trimmed.slice(7).trim());
        this.pushNotice("info", "Rule removed.");
      } catch {
        this.pushNotice("warn", "Could not remove the rule.");
      }
      return;
    }
    const pi = await this.intelligence();
    if (!pi) { this.pushNotice("info", "No project intelligence yet. Run: morrow cortex refresh"); return; }
    const lines = pi.userRules.filter((r) => r.active).map((r) => `${r.id.replace(/^rule-/, "").slice(0, 8)}  ${r.text}`);
    lines.push("", "Explicit rules outrank inferred conventions.", "Add with: /rules add \"<text>\"");
    this.outputViewer = { title: `repository rules`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionImpact(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet."); return; }
    const analyses = this.deps.backend.getMissionImpact ? await this.deps.backend.getMissionImpact(m.id).catch(() => []) : [];
    if (analyses.length === 0) { this.pushNotice("info", "No impact analysis was recorded for this mission."); return; }
    const impact = analyses[analyses.length - 1]!;
    const lines: string[] = [];
    const section = (label: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push(label + ":");
      for (const i of items.slice(0, 8)) lines.push(`  - ${i}`);
      lines.push("");
    };
    section("Likely affected", [...impact.likelyComponents, ...impact.likelyFiles.slice(0, 4)]);
    section("Relevant history", [...impact.relevantDecisions, ...impact.relevantFailures]);
    section("Repository rules", impact.relevantRules);
    section("Possible regressions", impact.possibleRegressions);
    section("Required verification", impact.requiredVerification);
    section("Uncertain", impact.uncertainty);
    this.outputViewer = { title: "change impact", lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showMissionRevisions(): Promise<void> {
    const m = await this.latestMission();
    if (!m) { this.pushNotice("info", "No mission in this project yet."); return; }
    const revisions = this.deps.backend.getMissionRevisions ? await this.deps.backend.getMissionRevisions(m.id).catch(() => []) : [];
    if (revisions.length === 0) { this.pushNotice("info", "No plan revisions - the original plan held."); return; }
    const lines: string[] = [];
    for (const r of revisions) {
      lines.push(`PLAN REVISION ${r.revision}  (${r.trigger.replace(/_/g, " ")})`);
      if (r.invalidatedAssumption) lines.push(`  invalidated: ${r.invalidatedAssumption}`);
      for (const t of r.tasksRemoved) lines.push(`  - ${t}`);
      for (const t of r.tasksAdded) lines.push(`  + ${t}`);
      lines.push("");
    }
    this.outputViewer = { title: `plan revisions (${revisions.length})`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showAgents(): Promise<void> {
    const named = await this.deps.backend.listAgents?.().catch(() => []) ?? [];
    const active = this.term.agents;
    const lines: string[] = [];
    if (active.length > 0) {
      lines.push("Active");
      for (const a of active) lines.push(`  ${a.name} [${a.role}] ${a.status}${a.taskId ? ` task ${a.taskId}` : ""}`);
      lines.push("");
    }
    if (named.length > 0) {
      lines.push("Project agents");
      for (const agent of named) {
        lines.push(`  ${agent.name} [${agent.role}] ${agent.enabled ? "enabled" : "disabled"}`);
        const firstInstruction = agent.instructions?.split(/\r?\n/).find((line) => line.trim().length > 0);
        if (firstInstruction) lines.push(`    ${firstInstruction.slice(0, 120)}`);
      }
    }
    this.outputViewer = { title: "agents", lines: lines.length ? lines : ["(no project agents or active subagents)"] };
    this.input = { ...this.input, overlay: "output" };
  }

  private async showDiff(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No task has run yet in this session.");
      return;
    }
    if (!this.deps.backend.getTaskDiff) {
      this.pushNotice("info", "Diff inspection isn't available in this session.");
      return;
    }
    const diff = await this.deps.backend.getTaskDiff(this.lastTaskId).catch(() => null);
    if (!diff || !diff.diff) {
      this.pushNotice("info", "No changes were made by the last task.");
      return;
    }
    const lines = diff.diff.split(/\r?\n/).map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`);
    this.outputViewer = { title: `diff · ${diff.files.join(", ")}`, lines };
    this.input = { ...this.input, overlay: "output" };
  }

  private async undoLast(): Promise<void> {
    if (!this.lastTaskId) {
      this.pushNotice("info", "No task has run yet in this session.");
      return;
    }
    if (!this.deps.backend.undoTask) {
      this.pushNotice("info", "Undo isn't available in this session.");
      return;
    }
    const result = await this.deps.backend.undoTask(this.lastTaskId).catch((err) => {
      this.pushNotice("error", `Undo failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (result) {
      this.pushNotice("info", `Undone: ${result.restoredFiles.length} file${result.restoredFiles.length === 1 ? "" : "s"} restored.`);
    }
  }

  private refreshModeLabel(): void {
    this.meta.mode = modeLabel(this.settings.mode, this.settings.autoApprove);
    this.term = reduce(this.term, { type: "session.started", meta: this.meta });
  }

  // ── Task streaming ─────────────────────────────────────────────────────────

  /**
   * Idempotently ingest one raw orchestrator event: accept it into the shared
   * event ledger at most once (covers persisted-history overlap, reconnect,
   * and SSE replay — the single ownership boundary is `EventLedger`), then
   * apply every terminal event `mapTaskEvent` derives from it. Deduping the
   * raw event *before* mapping (not per mapped terminal event) matters: one
   * raw event like `patch.recovery_feedback` can map to more than one
   * terminal event (a problem line and a strategy line), and both must be
   * applied together or not at all.
   */
  private ingestRawTaskEvent(raw: RawTaskEvent): void {
    // Always route through the ledger — `EventLedger.ingest`/`eventIdentity`
    // already fall back to `type:sequence` for an id-less event, the same
    // fallback `output-report.ts` uses, so this is never a second, weaker
    // identity rule for the id-less case. `currentTaskId` scopes that
    // fallback to the task currently streaming (set before both call sites
    // below start their subscribe loop, including `/continue`, which reuses
    // the same task id), so a new task's id-less events are never mistaken
    // for a replay of an earlier task's.
    if (!this.eventLedger.ingest(raw, this.currentTaskId ?? undefined)) return;
    for (const te of mapTaskEvent(raw)) this.applyEvent(te);
  }

  private async runTask(text: string): Promise<void> {
    this.applyEvent({ type: "user.message", text });
    this.busy = true;
    this.streamStart = this.now();
    this.busyInputNotified = false;
    this.input = { ...this.input, confirmExit: false };
    const abort = new AbortController();
    this.streamAbort = abort;
    this.requestPaint(true);
    try {
      const { taskId, routing } = await this.deps.backend.send(text, { ...this.settings });
      this.currentTaskId = taskId;
      this.lastTaskId = taskId;
      if (routing) this.applyEvent({ type: "routing", ...routing });
      for await (const raw of this.deps.backend.subscribe(taskId, abort.signal)) {
        if (raw.type === "plan.created" || raw.type === "step.started" || raw.type === "step.completed") {
          void this.refreshPlan(taskId);
        }
        if (raw.type === "approval.requested") {
          await this.openApproval(raw);
          continue;
        }
        this.ingestRawTaskEvent(raw);
      }
      this.applyEvent({ type: "assistant.end" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.applyEvent({ type: "task.failed", message: msg });
      // Surface a human-friendly interpreted error as a notice (in addition
      // to the raw message stored in lastError for /details).
      try {
        const { interpretError, formatInterpretedError } = await import("./errors.js");
        this.pushNotice("error", formatInterpretedError(interpretError(msg)));
      } catch {
        this.pushNotice("error", msg);
      }
    } finally {
      this.busy = false;
      this.lastTaskElapsedMs = this.now() - this.streamStart;
      this.currentTaskId = null;
      this.streamAbort = null;
      this.clearStillWorkingNotice();
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
    this.busyInputNotified = false;
    this.input = { ...this.input, confirmExit: false };
    const abort = new AbortController();
    this.streamAbort = abort;
    this.currentTaskId = this.lastTaskId;
    this.requestPaint(true);
    try {
      // Capture the persisted cursor before resuming. Starting from zero would
      // replay the historical task.interrupted event, which legitimately ends
      // an SSE stream before any post-resume answer can arrive.
      const aggregate = await this.deps.backend.getTask(this.lastTaskId);
      const after = aggregate.events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
      await this.deps.backend.resume(this.lastTaskId);
      for await (const raw of this.deps.backend.subscribe(this.lastTaskId, abort.signal, after)) {
        if (raw.type === "approval.requested") { await this.openApproval(raw); continue; }
        if (raw.type === "plan.created" || raw.type === "step.started" || raw.type === "step.completed") void this.refreshPlan(this.lastTaskId);
        this.ingestRawTaskEvent(raw);
      }
      this.applyEvent({ type: "assistant.end" });
    } catch (error) {
      this.pushNotice("error", `Could not continue task: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      this.lastTaskElapsedMs = this.now() - this.streamStart;
      this.currentTaskId = null;
      this.streamAbort = null;
      this.clearStillWorkingNotice();
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
    // Only an explicit y/s/p/n or Ctrl+C decides; Enter/Space/etc. are no-ops so
    // a queued keystroke from streaming can never accidentally approve.
    const decision = approvalDecisionForKey(k);
    if (decision === null) return;

    let trust: string | undefined;
    if ((decision === "trust_session" || decision === "trust_project") && ap.kind === "command") {
      trust = String((ap.details as any).pattern ?? "");
    }

    this.pendingApproval = null;
    this.pushNotice(decision === "deny" ? "warn" : "info", `${ap.kind === "command" ? "Command" : "Patch"} ${approvalDecisionLabel(decision)}.`);
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

  /**
   * Push a notice that asserts the *current* YOLO permission state (an on/
   * off/status toggle result, or /panic's forced-off), first dropping any
   * earlier such notice still sitting in the bounded notices list. Without
   * this, an "on" notice followed soon after by an "off" notice (or vice
   * versa) can both still be visible in the same frame — two contradictory
   * "current state" claims at once. The header/`/permissions`/`/yolo
   * status` all read `settings.autoApprove` directly and are unaffected;
   * this only prevents a *stale* state-change announcement from lingering
   * beside the current one.
   */
  private pushYoloNotice(level: "info" | "warn", text: string): void {
    this.term = { ...this.term, notices: this.term.notices.filter((n) => !n.text.startsWith("YOLO ") && !n.text.startsWith("Panic stop:")) };
    this.pushNotice(level, text);
  }

  /** Drop the transient "still working" notice once a task stops being
   *  busy — called from every `runTask`/`continueTask` `finally`. */
  private clearStillWorkingNotice(): void {
    if (this.term.notices.some((n) => n.text === STILL_WORKING_NOTICE)) {
      this.term = { ...this.term, notices: this.term.notices.filter((n) => n.text !== STILL_WORKING_NOTICE) };
    }
  }

  /**
   * The actually-served provider/model for this task, from `provider.usage`
   * (which reflects live routing/fallback resolution — see
   * task-event-adapter.ts's `provider.usage` case), falling back to the
   * configured value only when no task has reported usage yet. Every
   * consumer that shows "which model" (`/status`, `/context`) must read
   * this instead of `this.meta.provider/model` directly, so a session that
   * never pinned a model doesn't show a stale "auto" forever once routing
   * has actually resolved something concrete.
   */
  private resolvedModelText(): string {
    // A provider usage event is the authoritative post-fallback answer for
    // the current task. Before the first response (or for a task that fails
    // before usage), the send response already contains the resolved route;
    // never regress to the configured `auto/auto` label in that interval.
    const u = this.term.activeUsage;
    if (u?.provider && u.model) return `${u.provider}/${u.model}`;
    const routing = this.term.routing;
    if (routing?.provider && routing.model) return `${routing.provider}/${routing.model}`;
    const historical = this.term.usage;
    return historical?.provider && historical.model ? `${historical.provider}/${historical.model}` : `${this.meta.provider}/${this.meta.model}`;
  }

  /**
   * Single source of truth for the context-usage summary text. `/context`
   * and `/status` must both call this instead of independently recomputing
   * a percentage from raw fields — that drift (each reading `contextUsage.
   * maxTokens`, which gets reset to 0 by nearly every mid-turn usage event)
   * is exactly what let used/max/percent contradict each other before.
   * Returns null when no context usage has been reported yet, and reports
   * an unknown limit honestly instead of a guessed/generic number.
   */
  private contextUsageText(): string | null {
    const cu = this.term.contextUsage;
    if (!cu) return null;
    const limit = contextLimit(this.term);
    const pct = limit && limit > 0 ? (cu.percent ?? Math.round((cu.usedTokens / limit) * 100)) : null;
    const tokens = limit && limit > 0 ? `${cu.usedTokens}/${limit} tokens (${pct}%)` : `${cu.usedTokens} tokens (limit unknown)`;
    const extras = [
      cu.compactedGroups > 0 ? `${cu.compactedGroups} groups compacted` : null,
      cu.removedGroups > 0 ? `${cu.removedGroups} groups trimmed` : null,
    ].filter((x): x is string => x !== null);
    return [tokens, cu.method, ...extras].join("  ·  ");
  }

  /**
   * Which subsystem owns the terminal right now. Derived — never a second,
   * separately maintained flag — so it can't drift out of sync with the
   * state it describes. Exactly one thing may write to the terminal at a
   * time; `paint()` and `requestPaint()` both consult this before doing
   * anything, so the normal per-frame loop and a one-time out-of-band write
   * (`emitScrollbackReport`) can never interleave and corrupt each other.
   */
  private renderMode(): RenderMode {
    if (!this.active) return "shutting_down";
    if (this.reportWriteInProgress) return "output_report";
    if (this.pendingApproval || this.input.overlay !== "none") return "overlay";
    return "live_chat";
  }

  private requestPaint(force: boolean): void {
    const mode = this.renderMode();
    if (mode === "shutting_down" || mode === "output_report") return;
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
    if (this.renderMode() === "output_report") return;
    const { io } = this.deps;
    if (io.isTTY) io.write("\x1b[2J" + HOME);
    this.paint();
  }

  /** Compose and write the frame, position the caret, manage cursor visibility. */
  private paint(): void {
    const mode = this.renderMode();
    if (mode === "shutting_down" || mode === "output_report") return;
    this.lastPaintAt = this.now();
    const { io, out, unicode } = this.deps;
    const promptLabel = out.green(unicode ? "› " : "> ");
    // While busy the elapsed timer feeds the footer; after a task it feeds
    // the completion card's "N tools · 18s" line.
    const elapsedMs = this.busy ? this.now() - this.streamStart : this.lastTaskElapsedMs;
    const frame = composeApp(this.term, this.input, out, unicode, this.keyCtx, {
      columns: io.columns,
      rows: io.rows,
      tick: this.tick,
      ...(elapsedMs !== null ? { elapsedMs } : {}),
      promptLabel,
      promptWidth: 2,
    });

    const lines = this.pendingApproval ? this.approvalFrameLines() : this.input.overlay === "mission" ? this.missionFrameLines() : this.input.overlay === "output" || this.input.overlay === "tasktree" ? this.outputFrameLines() : frame.lines;
    if (!io.isTTY) {
      io.write(lines.join("\n") + "\n");
      return;
    }
    let out2 = CURSOR_HIDE + composePaintBody(lines, this.lastFrameRows);
    this.lastFrameRows = lines.length;
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
      const d = commandApprovalView(ap.details);
      const risk = riskLabel(d.risk);
      const glyph = riskGlyph(risk);

      lines.push(out.bold(`  Command approval  ${out.colorize(riskColor(risk), glyph + " " + risk + " risk")}`));
      lines.push(`    ${out.gray("run:")} ${d.commandLine}`);
      lines.push(`    ${out.gray("dir:")} ${d.cwd}`);
      lines.push(`    ${out.gray("why:")} ${d.purpose}`);
      if (d.preview) {
        lines.push(out.gray("    ── preview ──"));
        for (const previewLine of String(d.preview).split(/\r?\n/).slice(0, 5)) {
          lines.push(`    ${out.gray("│")} ${previewLine}`);
        }
        lines.push(out.gray("    ──"));
      }
      lines.push("");
      // Auto-approved actions shown when YOLO is on.
      if (this.settings.autoApprove) {
        lines.push(out.yellow("  ⚡ YOLO active — projects edits & commands are auto-approved."));
        lines.push(out.gray("  Hard blocks: secrets, privilege escalation, destructive git, workspace escape, force push."));
        lines.push("");
      }
      lines.push(out.gray(`  permission mode: ${modeLabel(this.settings.mode, this.settings.autoApprove)}`));
      lines.push(out.yellow(approvalActionsLine("approve")));
      lines.push(out.gray("  Enter does nothing here — press y, s, p, or n."));
    } else {
      const d = changeSetApprovalView(ap.details);
      lines.push(out.bold("  Patch approval"));
      lines.push(`    ${out.gray("files:")} ${d.filesLabel}`);
      if (d.additions !== undefined || d.deletions !== undefined) {
        const churn = [d.additions > 0 ? out.green(`+${d.additions}`) : "", d.deletions > 0 ? out.red(`-${d.deletions}`) : ""].filter(Boolean).join(" ");
        if (churn) lines.push(`    ${out.gray("changes:")} ${churn}`);
      }
      lines.push(`    ${out.gray("why:")} ${d.explanation}`);
      if (d.diffPreview) {
        lines.push(out.gray("    ── diff preview ──"));
        for (const diffLine of String(d.diffPreview).split(/\r?\n/).slice(0, 8)) {
          const trimmed = diffLine.length > 80 ? diffLine.slice(0, 77) + "…" : diffLine;
          lines.push(`    ${out.gray("│")} ${trimmed}`);
        }
        lines.push(out.gray("    ──"));
      }
      lines.push("");
      if (this.settings.autoApprove) {
        lines.push(out.yellow("  ⚡ YOLO active — patches are auto-approved."));
        lines.push(out.gray("  Hard blocks: external writes, credential files, system paths."));
        lines.push("");
      }
      lines.push(out.gray(`  permission mode: ${modeLabel(this.settings.mode, this.settings.autoApprove)}`));
      lines.push(out.yellow(approvalActionsLine("apply")));
      lines.push(out.gray("  Enter does nothing here — press y, s, p, or n."));
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

  private missionFrameLines(): string[] {
    const out = this.deps.out;
    const base = this.composeBaseLines();
    const available = Math.max(6, this.deps.io.rows - base.length - 4);

    const tabs = ["Task Tree", "Live State", "Mission Result"];
    const tabsLine = tabs
      .map((label, i) => {
        const prefix = i === this.missionTab ? out.bold(` ${i + 1} `) : out.gray(` ${i + 1} `);
        return i === this.missionTab ? out.bold(`${prefix}${label}`) : out.gray(`${prefix}${label}`);
      })
      .join(out.gray("  |  "));

    const lines: string[] = [
      ...base,
      "",
      out.bold("  Mission Control"),
      `  ${tabsLine}`,
      out.gray("  " + "─".repeat(Math.min(60, this.deps.io.columns - 2))),
    ];

    let content: string[] = [];
    if (this.missionTab === 0 && this.missionCache.tree) {
      content = this.missionCache.tree;
    } else if (this.missionTab === 1 && this.missionCache.cockpit) {
      content = this.missionCache.cockpit;
    } else if (this.missionTab === 2 && this.missionCache.result) {
      content = this.missionCache.result;
    } else {
      content = ["Loading…"];
    }

    lines.push("");
    for (const line of content.slice(0, available)) {
      lines.push(`  ${line}`);
    }

    lines.push("");
    lines.push(out.gray("  ← → or 1/2/3 to switch tabs · Esc to close"));
    return lines;
  }

  private composeBaseLines(): string[] {
    const { io, out, unicode } = this.deps;
    return composeApp(this.term, this.input, out, unicode, this.keyCtx, {
      columns: io.columns,
      rows: io.rows,
      tick: this.tick,
      promptLabel: out.green(unicode ? "› " : "> "),
      promptWidth: 2,
    }).lines.slice(0, -4); // drop separator + input + completion + footer
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
    if (io.isTTY) io.write(PASTE_OFF + CURSOR_SHOW);
  }

  // Test accessors.
  snapshot(): TerminalState {
    return this.term;
  }
  inputSnapshot(): InputState {
    return this.input;
  }
}
