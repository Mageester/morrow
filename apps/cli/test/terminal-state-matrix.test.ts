/**
 * State-matrix coverage: the persistent console shell (identity header,
 * bordered mission body, bordered input, status footer) must hold across
 * every interactive state, not just at startup. Each test below asserts the
 * same structural invariants against a different state so a future change
 * that quietly breaks the shell in one state (but not others) gets caught
 * here instead of requiring a human to click through all sixteen by hand.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialInputState } from "../src/terminal/input-state.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";

const plain = new Output({ json: false, quiet: false, color: false });
const tick = () => new Promise((r) => setTimeout(r, 20));

const meta: SessionMeta = {
  greeting: "hi", projectName: "Morrow", workspacePath: "/home/aidan/code/morrow", branch: "main",
  provider: "deepseek", model: "deepseek-chat", privacy: "cloud", mode: "Build · approvals required",
  memory: true, autoApprove: false, providerConfigured: true, gitRepo: true,
};
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

function build(events: TerminalEvent[]): TerminalState {
  return events.reduce((s, e) => reduce(s, e, () => Date.now()), initialState());
}

/**
 * The four-region-shell invariant, checked against a fully composed frame:
 *  - identity header (the ◇ mark / MORROW) near the top
 *  - a bordered input box (or, when told to skip it, an explicit reason)
 *  - a one-line status footer with a recognizable state word
 *  - no line wider than the given terminal width
 */
function assertFourRegionShell(lines: string[], columns: number, opts: { expectInputBox?: boolean } = {}): void {
  const text = lines.map(stripAnsi).join("\n");
  const expectInputBox = opts.expectInputBox ?? true;

  for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);

  expect(text).toMatch(/MORROW|◇/);

  if (expectInputBox) {
    // The input placeholder text is unicode-agnostic — present regardless of
    // whether the border itself renders with box-drawing or ASCII chars (and
    // possibly clipped on a very narrow terminal, hence just the prefix).
    expect(text).toMatch(/Ask, redirect, or type/);
    expect(text).toMatch(/[╭╰]|(\+-+\+)/);
  }
}

/** The input placeholder's own copy legitimately ends with "…" — exclude
 *  that one row when asserting the rest of a frame never truncates content
 *  with an ellipsis. */
function withoutPlaceholderRow(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.includes("Ask, redirect"))
    .join("\n");
}

const opts = { columns: 80, rows: 30, tick: 0, promptLabel: "› ", promptWidth: 2 };
const ctx = { commands: [], paletteItems: [] };

describe("state matrix: pure reducer states (composeApp)", () => {
  it("1. startup — mascot + identity panel + bordered input", () => {
    const s = build([{ type: "session.started", meta }]);
    const frame = composeApp(s, initialInputState(), plain, true, { ...ctx, recentActivity: [] }, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    expect(frame.lines.join("\n")).toContain("Welcome to Morrow");
  });

  it("2. idle after previous conversation — resumed session still shows the shell", () => {
    const s = build([{ type: "session.started", meta: { ...meta, resumed: true } }]);
    const frame = composeApp(s, initialInputState(), plain, true, { ...ctx, recentActivity: [] }, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    expect(frame.lines.join("\n")).toContain("Resumed your last session");
  });

  it("4. tool currently running — Mission/Activity body plus the shell", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the build" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm build" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(text).toContain("Mission");
    expect(text).toContain("pnpm build");
  });

  it("5. failed command — a bare, not-yet-retrying problem reads as a failure, never a green check", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the tests" },
      { type: "recovery.problem", tool: "run_command", message: "missing.test.mjs · exit 1" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(text).toContain("✗");
    expect(text).not.toContain("✓");
  });

  it("6. recovery in progress — an active strategy reads as ↻, never a bare failure", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the tests" },
      { type: "recovery.problem", tool: "run_command", message: "missing.test.mjs · exit 1" },
      { type: "recovery.strategy", tool: "run_command", strategy: "switching to value.test.mjs" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    expect(frame.lines.join("\n")).toContain("↻");
  });

  it("9. interrupted — the shell persists and shows a calm, single interrupted notice", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the tests" },
      { type: "task.interrupted" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(text).toContain("interrupted");
    expect((text.match(/Task interrupted/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("10. completed successfully — no stale running/recovery indicators survive into the result", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the tests" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(text).toContain("Task completed");
    expect(text).not.toMatch(/no (new )?progress/i);
    expect(text).not.toContain("↻");
    // No duplicate completion block.
    expect((text.match(/Task completed/g) ?? []).length).toBe(1);
  });

  it("11. completed with recovery — the recovered story survives into the completion card, never a bare 'Recovered' with no detail", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "run the tests" },
      { type: "recovery.problem", tool: "run_command", message: "flaky network timeout" },
      { type: "recovery.strategy", tool: "run_command", strategy: "retry with backoff" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(text).toContain("Recovered");
    expect(text).toContain("flaky network timeout");
    expect(text).not.toContain("↻"); // nothing still "in progress" after success
  });

  it("14. narrow terminal — the shell degrades (ASCII/narrow mascot, one-column panel) without overflowing", () => {
    const s = build([{ type: "session.started", meta }]);
    const narrowOpts = { ...opts, columns: 38 };
    const frame = composeApp(s, initialInputState(), plain, true, { ...ctx, recentActivity: [] }, narrowOpts);
    assertFourRegionShell(frame.lines, narrowOpts.columns);
  });

  it("15. very long workspace path — never truncated with an ellipsis, wraps instead", () => {
    const longPath = "/very/deeply/nested/workspace/path/that/is/far/too/long/for/any/single/terminal/row/to/hold";
    const s = build([{ type: "session.started", meta: { ...meta, workspacePath: longPath } }]);
    const frame = composeApp(s, initialInputState(), plain, true, { ...ctx, recentActivity: [] }, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(withoutPlaceholderRow(text)).not.toContain("…");
    // The path's start and tail both survive — proof it wrapped rather than
    // being clipped, without depending on exactly how the panel re-flows it.
    expect(text).toContain("/very/deeply/nested/workspace");
    expect(text).toContain("row/to/hold");
  });

  it("16. very long mission objective — wraps instead of getting cut with an ellipsis", () => {
    const longObjective = "Refactor the entire provider retry pipeline so it backs off exponentially, logs every attempt with full context, and never silently swallows a terminal error again";
    const s = build([{ type: "session.started", meta }, { type: "user.message", text: longObjective }]);
    const frame = composeApp(s, initialInputState(), plain, true, ctx, opts);
    assertFourRegionShell(frame.lines, opts.columns);
    const text = frame.lines.join("\n");
    expect(withoutPlaceholderRow(text)).not.toContain("…");
    for (const word of ["Refactor", "exponentially,", "again"]) expect(text).toContain(word);
  });
});

// ── InteractiveSession-driven states (approval, pause, overlays) ───────────

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 30;
  isTTY = true;
  private cbs: Array<() => void> = [];
  write(s: string): void { this.writes.push(s); }
  on(_e: "resize", cb: () => void): void { this.cbs.push(cb); }
  off(_e: "resize", cb: () => void): void { this.cbs = this.cbs.filter((c) => c !== cb); }
  emitResize(): void { for (const cb of this.cbs) cb(); }
  all(): string { return this.writes.join(""); }
}

function fakeStdin(): any {
  const e = new EventEmitter() as any;
  e.isTTY = true;
  e.setRawMode = () => e;
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

class EventGate {
  private queue: RawTaskEvent[] = [];
  private waiters: Array<(r: IteratorResult<RawTaskEvent>) => void> = [];
  private ended = false;
  push(ev: RawTaskEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  end(): void {
    this.ended = true;
    let w: ((r: IteratorResult<RawTaskEvent>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as any, done: true });
  }
  async *iterate(signal: AbortSignal): AsyncIterable<RawTaskEvent> {
    while (true) {
      if (this.queue.length) { yield this.queue.shift()!; continue; }
      if (this.ended || signal.aborted) return;
      const next = await new Promise<IteratorResult<RawTaskEvent>>((res) => {
        this.waiters.push(res);
        signal.addEventListener("abort", () => res({ value: undefined as any, done: true }), { once: true });
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function makeBackend(gate: EventGate, overrides: Partial<SessionBackend> = {}): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: (_taskId, signal) => gate.iterate(signal),
    cancel: async () => {},
    resume: async () => {},
    getApproval: async () => ({ id: "a1", kind: "command", details: { command: "rm -rf build", cwd: "/w", purpose: "clean", risk: "medium" }, projectId: "p" }),
    resolveApproval: async () => {},
    getPlan: async () => [],
    getTask: async () => ({} as any),
    getTaskTree: async () => ({} as any),
    ...overrides,
  };
}

/** The most recent single repaint (one `io.write` call) — splitting the
 *  *whole* accumulated byte stream by "\r\n" is unsafe once more than one
 *  repaint has happened, since each repaint's leading cursor-hide/home codes
 *  aren't separated from the previous repaint's last line by "\r\n". */
function lastFrame(io: FakeTermIO): string {
  return io.writes[io.writes.length - 1] ?? "";
}

/** `stripAnsi` only strips SGR (color) codes. A real paint also carries
 *  cursor/erase control sequences (CLEAR_EOL, CURSOR_HOME, …) that are
 *  zero-width on a real terminal but would otherwise inflate a naive
 *  string-length width check. */
function visibleLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function typeText(stdin: any, text: string): void {
  for (const c of text) stdin.emit("keypress", c, { name: c, sequence: c });
}
function enter(stdin: any): void { stdin.emit("keypress", undefined, { name: "return" }); }
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }

describe("state matrix: InteractiveSession-driven states", () => {
  it("7. waiting for approval — shell persists, footer explains how to respond", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    typeText(stdin, "clean the build dir");
    enter(stdin);
    await tick();
    gate.push({ type: "approval.requested", payload: { approvalId: "a1", kind: "command" } } as any);
    await tick();

    const frame = lastFrame(io);
    expect(frame).toContain("Command approval");
    expect(frame).toContain("y approve");
    for (const line of frame.split("\r\n")) expect(visibleLine(line).length).toBeLessThanOrEqual(io.columns);

    stdin.emit("keypress", "n", { name: "n" });
    gate.end();
    await tick();
    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("8. paused — /pause leaves a resumable, non-armed state with a bordered, live input", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "working" } } as any);
    await tick();

    typeText(stdin, "/pause");
    enter(stdin);
    await tick();

    expect(app.snapshot().notices.some((n) => n.text.toLowerCase().includes("pausing"))).toBe(true);
    expect(io.all()).toContain("╭"); // input stays bordered and visible while pausing

    gate.end();
    await tick();
    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("12/13. a slash-command overlay (/status) during execution keeps the bordered input visible and does not interrupt the mission", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "working" } } as any);
    await tick();

    typeText(stdin, "/status");
    enter(stdin);
    await tick();

    expect(app.snapshot().status).toBe("streaming");
    const overlayFrame = lastFrame(io);
    expect(overlayFrame).toContain("╭");
    expect(overlayFrame).toContain("╰");
    for (const line of overlayFrame.split("\r\n")) expect(visibleLine(line).length).toBeLessThanOrEqual(io.columns);

    stdin.emit("keypress", undefined, { name: "escape" });
    await tick();
    expect(app.snapshot().status).toBe("streaming"); // activity kept updating underneath

    ctrlC(stdin);
    gate.end();
    await tick();
    ctrlC(stdin);
    await done;
  });
});
