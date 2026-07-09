/**
 * The interactive renderer: a bounded-FPS frame renderer that owns the screen.
 *
 * It paints in the normal terminal buffer, hides the cursor, recomposes on resize,
 * coalesces repaints to a frame budget, and restores the terminal deterministically
 * on stop — and on process exit, so a crash never leaves a broken terminal. All
 * terminal I/O goes through an injectable `TermIO`, so the whole lifecycle is
 * testable against a fake stream with no real TTY.
 *
 * This is the Phase-1 foundation. It is opt-in (`MORROW_TUI=1`) until it reaches
 * parity with the line-based REPL, so the working CLI is never destabilized.
 */
import type { Output } from "../cli/output.js";
import type { TerminalEvent } from "./events.js";
import type { Renderer } from "./renderer.js";
import { initialState, reduce, type TerminalState } from "./state.js";
import { composeFrame } from "./view.js";
import { composePaintBody } from "./paint.js";

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";

/** The minimal terminal surface the runtime needs. `process.stdout` satisfies it. */
export interface TermIO {
  write(s: string): void;
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  on(event: "resize", cb: () => void): void;
  off(event: "resize", cb: () => void): void;
}

/** Wrap a Node writable TTY (defaults to stdout) as a `TermIO`. */
export function nodeTermIO(stream: NodeJS.WriteStream = process.stdout): TermIO {
  return {
    write: (s) => void stream.write(s),
    get columns() {
      return stream.columns ?? 80;
    },
    get rows() {
      return stream.rows ?? 24;
    },
    isTTY: Boolean(stream.isTTY),
    on: (event, cb) => void stream.on(event, cb),
    off: (event, cb) => void stream.off(event, cb),
  };
}

export interface InteractiveOptions {
  unicode: boolean;
  /** Maximum repaints per second. Default 30. */
  maxFps?: number;
  /** Paint synchronously on every request (tests). Default false. */
  immediate?: boolean;
  now?: () => number;
  hint?: string;
}

export class InteractiveRenderer implements Renderer {
  private state: TerminalState = initialState();
  private active = false;
  private tick = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameRows = 0;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private lastPaintAt = 0;
  private readonly onResize = () => this.requestPaint(true);
  private readonly onExit = () => this.stop();

  constructor(
    private readonly io: TermIO,
    private readonly out: Output,
    private readonly opts: InteractiveOptions
  ) {
    this.minIntervalMs = Math.max(1, Math.floor(1000 / (opts.maxFps ?? 30)));
    this.now = opts.now ?? Date.now;
  }

  /** Enter the alternate screen and paint the first frame. Idempotent. */
  start(): void {
    if (this.active) return;
    this.active = true;
    if (this.io.isTTY) this.io.write(CURSOR_HIDE + CURSOR_HOME + CLEAR_BELOW);
    this.io.on("resize", this.onResize);
    process.once("exit", this.onExit);
    // Animate spinners while work is in flight.
    if (!this.opts.immediate) {
      this.heartbeat = setInterval(() => {
        if (this.state.status === "streaming") {
          this.tick++;
          this.requestPaint(true);
        }
      }, this.minIntervalMs * 2);
      if (typeof this.heartbeat.unref === "function") this.heartbeat.unref();
    }
    this.paint();
  }

  apply(event: TerminalEvent): void {
    this.state = reduce(this.state, event, this.now);
    if (!this.active) return;
    this.requestPaint(false);
  }

  /** Force a frame now (e.g. after Ctrl+L). */
  repaint(): void {
    this.requestPaint(true);
  }

  end(): string {
    this.stop();
    const last = [...this.state.conversation].reverse().find((c) => c.role === "assistant");
    return last?.text ?? "";
  }

  /** Restore the terminal. Idempotent and safe to call from an exit handler. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.io.off("resize", this.onResize);
    process.removeListener("exit", this.onExit);
    if (this.io.isTTY) this.io.write(CURSOR_SHOW);
  }

  private requestPaint(force: boolean): void {
    if (!this.active) return;
    if (this.opts.immediate) {
      this.paint();
      return;
    }
    const since = this.now() - this.lastPaintAt;
    if (force && since >= this.minIntervalMs) {
      this.paint();
      return;
    }
    if (this.timer) return; // a paint is already scheduled
    const delay = Math.max(0, this.minIntervalMs - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.paint();
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Compose and write a frame using clear-to-EOL per line to limit flicker. */
  private paint(): void {
    if (!this.active) return;
    this.lastPaintAt = this.now();
    const frame = this.frame();
    if (this.io.isTTY) {
      this.io.write(composePaintBody(frame, this.lastFrameRows));
    } else {
      // Non-TTY fallback: emit the frame once (used only if misconfigured).
      this.io.write(frame.join("\n") + "\n");
    }
    this.lastFrameRows = frame.length;
  }

  /** The current frame as pure lines (exposed for tests). */
  frame(): string[] {
    return composeFrame(this.state, this.out, this.opts.unicode, {
      columns: this.io.columns,
      rows: this.io.rows,
      tick: this.tick,
      ...(this.opts.hint !== undefined ? { hint: this.opts.hint } : {}),
    });
  }

  /** Current reduced state (exposed for tests). */
  snapshot(): TerminalState {
    return this.state;
  }
}
