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
import { glyphs } from "./view.js";
import { completionActive, initialInputState, insertPaste, reduceKey, type InputState, type KeyContext } from "./input-state.js";
import { PasteDecoder, normalizePaste } from "./paste.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
import { yoloPolicyText, yoloStatusText, riskLabel, riskGlyph, riskColor } from "./yolo.js";
import { approvalDecisionForKey, approvalDecisionLabel, approvalActionsLine } from "./approvals.js";
import { activityDetailLines } from "./activity-view.js";
import type { SessionMeta, TerminalEvent } from "./events.js";
import type { TermIO } from "./runtime.js";
import { formatMissionResult, formatTaskTree, formatLiveCockpit } from "./mission-control.js";

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
  getTask(taskId: string): Promise<import("../client/api.js").TaskAggregate>;
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
  /** Cortex staleness for the resume freshness check. */
  getCortexStaleness?(): Promise<import("./resume.js").ResumeStaleness | null>;
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
  private outputViewer: { title: string; lines: string[] } | null = null;
  private pendingApproval: ApprovalView | null = null;
  private confirmExitWhileBusy = false;
  private missionTab = 0; // 0=tree, 1=activity, 2=result
  private missionCache: { tree?: string[]; result?: string[]; cockpit?: string[] } = {};
  private resolveDone: (() => void) | null = null;
  private readonly now: () => number;
  private readonly pasteDecoder = new PasteDecoder();
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
      this.confirmExitWhileBusy = false;
      return;
    }

    // Ctrl+T opens mission control.
    if (k.ctrl && k.name === "t" && !k.meta && !k.shift) {
      void this.showMissionControl();
      return void this.requestPaint(false);
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
        if (this.term.contextUsage) {
          const u = this.term.contextUsage;
          const pct = u.maxTokens > 0 ? Math.round((u.usedTokens / u.maxTokens) * 100) : 0;
          this.pushNotice("info", `Context: ${u.usedTokens}/${u.maxTokens} tokens (${pct}%)  ·  ${u.method}${u.compactedGroups > 0 ? `  ·  ${u.compactedGroups} groups compacted` : ""}${u.removedGroups > 0 ? `  ·  ${u.removedGroups} groups trimmed` : ""}`);
        } else {
          this.pushNotice("info", "Context usage not available yet. Start a conversation first.");
        }
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
      case "output":
        await this.showOutput(arg || undefined);
        return void this.requestPaint(false);
      case "tree":
      case "tasks":
        await this.showTaskTree();
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
      const { resumeHasWarnings, resumeNoticeText } = await import("./resume.js");
      const digest = await this.buildResumeDigest();
      if (resumeHasWarnings(digest)) {
        this.pushNotice("warn", resumeNoticeText(digest));
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
      `${o.gray("model")}      ${this.meta.provider}/${this.meta.model}`,
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
    // Context usage if available.
    if (this.term.contextUsage) {
      const u = this.term.contextUsage;
      const pct = u.maxTokens > 0 ? Math.round((u.usedTokens / u.maxTokens) * 100) : 0;
      lines.push(`${o.gray("context")}    ${u.usedTokens}/${u.maxTokens} tokens (${pct}%)`);
    } else {
      lines.push(`${o.gray("context")}    ${o.gray("not available yet")}`);
    }
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

    const lines = this.pendingApproval ? this.approvalFrameLines() : this.input.overlay === "mission" ? this.missionFrameLines() : this.input.overlay === "output" || this.input.overlay === "tasktree" ? this.outputFrameLines() : frame.lines;
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
      const risk = riskLabel(d.risk);
      const glyph = riskGlyph(risk);
      const colorFn = out[riskColor(risk)];

      lines.push(out.bold(`  Command approval  ${colorFn(glyph + " " + risk + " risk")}`));
      lines.push(`    ${out.gray("run:")} ${d.executable} ${(d.args ?? []).join(" ")}`);
      if (d.workingDir) lines.push(`    ${out.gray("dir:")} ${d.workingDir}`);
      lines.push(`    ${out.gray("why:")} ${d.purpose ?? "(not specified)"}`);
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
      const d = ap.details as any;
      lines.push(out.bold("  Patch approval"));
      lines.push(`    ${out.gray("files:")} ${(d.files ?? []).join(", ")}`);
      if (d.additions !== undefined || d.deletions !== undefined) {
        const churn = [d.additions > 0 ? out.green(`+${d.additions}`) : "", d.deletions > 0 ? out.red(`-${d.deletions}`) : ""].filter(Boolean).join(" ");
        if (churn) lines.push(`    ${out.gray("changes:")} ${churn}`);
      }
      lines.push(`    ${out.gray("why:")} ${d.explanation ?? "(not specified)"}`);
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
