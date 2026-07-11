/**
 * The non-interactive, append-only renderer.
 *
 * Used for redirected output, CI, JSON mode, unsupported/dumb terminals,
 * accessibility, and logs. It never repaints or moves the cursor.
 *
 * Stdout contract: stdout receives exactly the FINAL answer, so a pipe gets
 * clean text. Turn text is buffered per turn; when a turn ends final it is
 * written to stdout, when it ends intermediate it goes to stderr as dim
 * narration (visible in a terminal, out of the way of pipes). Legacy streams
 * with no turn boundaries keep the old stream-as-it-arrives behavior.
 * Activity, actions, recovery stories, and the completion card go to stderr
 * as diagnostics — mirroring the contract the rest of the CLI relies on.
 */
import type { Output } from "../cli/output.js";
import { sanitizeTerminalText } from "../cli/output.js";
import type { ActivityKind, TerminalEvent } from "./events.js";
import type { Renderer } from "./renderer.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { actionLine, completionCard, glyphs, recoveryEntryLines } from "./view.js";

export interface LineRendererOptions {
  unicode: boolean;
  /** When false, suppress activity/tool diagnostics (answer text still streams). */
  showActivity: boolean;
  /** When true, print a completion summary block on the terminal task event. */
  showSummary: boolean;
}

export class LineRenderer implements Renderer {
  private state: TerminalState = initialState();
  private answer = "";
  private wroteText = false;
  private endedConversation = false;
  private startedAt = Date.now();

  /** Per-turn text buffers so stdout only ever receives the final answer. */
  private turnBuffers = new Map<string, string>();
  /** Recovery entries already printed (by tool+message), to print each stage once. */
  private printedRecoveryStages = new Map<string, string>();
  private completionPrinted = false;

  constructor(
    private readonly out: Output,
    private readonly opts: LineRendererOptions
  ) {}

  apply(event: TerminalEvent): void {
    this.state = reduce(this.state, event);
    const { out, opts } = this;
    const g = glyphs(opts.unicode);

    switch (event.type) {
      case "routing":
        if (opts.showActivity) {
          const provider = sanitizeTerminalText(event.provider);
          const model = sanitizeTerminalText(event.model);
          const preset = sanitizeTerminalText(event.preset);
          const privacy = sanitizeTerminalText(event.privacy);
          out.diag(
            out.gray(
              `${g.arrow} ${provider} · ${model} · preset ${preset}` +
                (event.fallback ? " · fallback" : "") +
                (event.overridden ? " · override" : "") +
                ` · ${privacy}`
            )
          );
        }
        break;

      case "assistant.turn_start":
        this.turnBuffers.set(event.turnId, "");
        break;

      case "assistant.delta": {
        const text = sanitizeTerminalText(event.text);
        // Legacy streams (no turn boundaries) keep streaming straight through.
        if (event.turnId === "legacy") {
          this.answer += text;
          out.write(text);
          this.wroteText = true;
          break;
        }
        this.turnBuffers.set(event.turnId, (this.turnBuffers.get(event.turnId) ?? "") + text);
        break;
      }

      case "assistant.turn_end": {
        const text = this.turnBuffers.get(event.turnId);
        this.turnBuffers.delete(event.turnId);
        if (!text || !text.trim()) break;
        if (event.final) {
          this.flushPendingNewline();
          this.answer = text;
          out.write(text);
          this.wroteText = true;
        }
        break;
      }

      case "assistant.end":
        this.flushPendingNewline();
        break;

      case "activity":
        if (opts.showActivity && !activityOwnedByRunningTool(event.kind, this.state)) {
          this.flushPendingNewline();
          const label = event.kind === "reading" ? "Read" : event.kind === "searching" ? "Searched" : event.kind === "inspecting" ? "Inspected" : event.kind;
          const detail = event.detail ? " " + sanitizeTerminalText(event.detail) : "";
          out.diag(out.gray(`  ${g.ok} ${label}${detail}${event.count !== undefined ? ` ${g.dot} ${event.count} result${event.count === 1 ? "" : "s"}` : ""}`));
        }
        break;

      case "tool.end":
        if (opts.showActivity) {
          this.flushPendingNewline();
          const card = this.state.tools.find((t) => t.id === event.id);
          if (card) {
            const line = actionLine(card, out, opts.unicode, this.state.meta?.workspacePath);
            if (line) out.diag(line);
          }
          if (event.status === "completed") this.printRecoveryProgress();
        }
        break;

      case "recovery.problem":
      case "recovery.strategy":
        if (opts.showActivity) {
          this.flushPendingNewline();
          this.printRecoveryProgress();
        }
        break;

      case "patch.applied": {
        if (opts.showActivity) {
          this.flushPendingNewline();
          out.diag(`  ${out.green(g.ok)} Changed ${out.gray(event.files.map(sanitizeTerminalText).join(", "))}`);
          this.printRecoveryProgress();
        }
        break;
      }

      case "patch.proposed":
        break;

      case "approval.auto":
        // YOLO auto-approvals are the expected mode of operation — logging each
        // one was noise. Provenance stays in the task record and /output full.
        break;

      case "notice":
        this.flushPendingNewline();
        if (event.level === "error") out.error(sanitizeTerminalText(event.text));
        else if (event.level === "warn") out.warn(sanitizeTerminalText(event.text));
        else out.info(sanitizeTerminalText(event.text));
        break;

      case "task.failed":
        this.flushPendingNewline();
        this.printCompletion();
        break;

      case "task.cancelled":
        this.flushPendingNewline();
        if (opts.showSummary) this.printCompletion();
        else out.warn("Response cancelled.");
        break;

      case "task.interrupted":
        this.flushPendingNewline();
        if (opts.showSummary) this.printCompletion();
        else out.warn("Response interrupted.");
        break;

      case "task.stalled":
      case "task.budget_reached":
        this.flushPendingNewline();
        if (opts.showSummary) this.printCompletion();
        else out.warn(event.type === "task.stalled" ? "Task paused." : "Task budget reached.");
        break;

      case "task.completed":
        this.flushPendingNewline();
        this.printCompletion();
        break;

      case "recovery.suggestion":
        this.flushPendingNewline();
        out.warn(`Recovery: ${sanitizeTerminalText(event.text)}`);
        break;

      // State-only events that don't produce incremental line output.
      case "git.state":
      case "context.usage":
      case "progress.stage":
      case "process.update":
      case "worktree.update":
      case "agent.update":
      case "integration.update":
        break;

      // session.started / user.message carry no incremental line output here.
      default:
        break;
    }
  }

  end(): string {
    if (!this.endedConversation) {
      this.flushPendingNewline();
      this.endedConversation = true;
    }
    return this.answer;
  }

  /** Public flush of any pending streamed-text newline, e.g. before a prompt. */
  flush(): void {
    this.flushPendingNewline();
  }

  /** The answer text streamed so far (exposed for callers that need it early). */
  get answerText(): string {
    return this.answer;
  }

  /** Print each recovery entry's newly-reached stage exactly once. */
  private printRecoveryProgress(): void {
    const taskFailed = this.state.status === "failed";
    for (const entry of this.state.recoveries) {
      const key = `${entry.tool}\u0000${entry.message}`;
      const stage = `${entry.status}:${entry.count}`;
      if (this.printedRecoveryStages.get(key) === stage) continue;
      this.printedRecoveryStages.set(key, stage);
      const lines = recoveryEntryLines(entry, this.out, this.opts.unicode, taskFailed);
      // Print only the line for the newly reached stage: the last line of the story.
      const last = lines[lines.length - 1];
      if (last) this.out.diag(last);
    }
  }

  private printCompletion(): void {
    if (this.completionPrinted) return;
    this.completionPrinted = true;
    if (!this.opts.showSummary) {
      if (this.state.status === "failed" && this.state.lastError) this.out.error(`Task failed: ${this.state.lastError}`);
      return;
    }
    this.out.diag("");
    for (const line of completionCard(this.state, this.out, { unicode: this.opts.unicode, elapsedMs: Date.now() - this.startedAt })) {
      this.out.diag(line);
    }
  }

  private flushPendingNewline(): void {
    if (this.wroteText) {
      this.out.write("\n");
      this.wroteText = false;
    }
  }
}

function activityOwnedByRunningTool(kind: ActivityKind, state: TerminalState): boolean {
  const runningNames = new Set(state.tools.filter((tool) => tool.status === "running").map((tool) => tool.name));
  if (kind === "reading") return runningNames.has("read_file");
  if (kind === "searching") return ["search_text", "search_files", "search_symbols"].some((name) => runningNames.has(name));
  if (kind === "inspecting") return ["inspect_workspace", "list_files", "git_status", "git_diff", "git_log"].some((name) => runningNames.has(name));
  return false;
}
