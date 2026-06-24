/**
 * The non-interactive, append-only renderer.
 *
 * Used for redirected output, CI, JSON mode, unsupported/dumb terminals,
 * accessibility, and logs. It never repaints or moves the cursor: the assistant
 * answer streams to stdout (so a pipe gets clean text), while activity, tool
 * cards, patches, and the completion summary go to stderr as diagnostics. This
 * mirrors the contract the rest of the CLI already relies on.
 */
import type { Output } from "../cli/output.js";
import type { TerminalEvent } from "./events.js";
import type { Renderer } from "./renderer.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { activityLine, completionLines, glyphs, patchLines, toolCardLines } from "./view.js";

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
          out.diag(
            out.gray(
              `${g.arrow} ${event.provider} · ${event.model} · preset ${event.preset}` +
                (event.fallback ? " · fallback" : "") +
                (event.overridden ? " · override" : "") +
                ` · ${event.privacy}`
            )
          );
        }
        break;

      case "assistant.delta":
        this.answer += event.text;
        out.write(event.text);
        this.wroteText = true;
        break;

      case "assistant.end":
        this.flushPendingNewline();
        break;

      case "activity":
        if (opts.showActivity) {
          this.flushPendingNewline();
          out.diag(activityLine({ kind: event.kind, at: 0, ...(event.detail !== undefined ? { detail: event.detail } : {}), ...(event.count !== undefined ? { count: event.count } : {}) }, out, opts.unicode));
        }
        break;

      case "tool.end":
        if (opts.showActivity) {
          this.flushPendingNewline();
          const card = this.state.tools.find((t) => t.id === event.id);
          if (card) for (const line of toolCardLines(card, out, opts.unicode)) out.diag(line);
        }
        break;

      case "patch.applied":
      case "patch.proposed":
        if (opts.showActivity) {
          this.flushPendingNewline();
          const patch = this.state.patches[this.state.patches.length - 1];
          if (patch) for (const line of patchLines(patch, out, opts.unicode)) out.diag(line);
        }
        break;

      case "approval.auto":
        if (opts.showActivity) {
          this.flushPendingNewline();
          out.diag(out.gray(`  ${g.bullet} auto-approved · ${event.summary}`));
        }
        break;

      case "notice":
        this.flushPendingNewline();
        if (event.level === "error") out.error(event.text);
        else if (event.level === "warn") out.warn(event.text);
        else out.info(event.text);
        break;

      case "task.failed":
        this.flushPendingNewline();
        out.error(`Task failed: ${event.message}`);
        break;

      case "task.cancelled":
        this.flushPendingNewline();
        out.warn("Response cancelled.");
        break;

      case "task.interrupted":
        this.flushPendingNewline();
        out.warn("Response interrupted.");
        break;

      case "task.completed":
        this.flushPendingNewline();
        if (opts.showSummary) {
          out.diag("");
          for (const line of completionLines(this.state, out, opts.unicode)) out.diag(line);
        }
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

  private flushPendingNewline(): void {
    if (this.wroteText) {
      this.out.write("\n");
      this.wroteText = false;
    }
  }
}
