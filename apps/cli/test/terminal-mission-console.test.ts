import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Output, stripAnsi } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";
import { initialState, reduce } from "../src/terminal/state.js";
import { actionLine, recoveryEntryLines } from "../src/terminal/view.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialInputState } from "../src/terminal/input-state.js";

const plain = new Output({ json: false, quiet: false, color: false });
const tick = () => new Promise((r) => setTimeout(r, 20));

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;
  private cbs: Array<() => void> = [];
  write(s: string): void { this.writes.push(s); }
  on(_e: "resize", cb: () => void): void { this.cbs.push(cb); }
  off(_e: "resize", cb: () => void): void { this.cbs = this.cbs.filter((c) => c !== cb); }
  emitResize(): void { for (const cb of this.cbs) cb(); }
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

const meta: SessionMeta = {
  greeting: "hi", projectName: "M", workspacePath: "/w", branch: "main",
  provider: "mock", model: "mock-model", privacy: "local", mode: "Build · approvals required",
  memory: true, autoApprove: false,
};
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

function makeBackend(gate: EventGate, cancel: () => void): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: (_taskId, signal) => gate.iterate(signal),
    cancel: async () => cancel(),
    resume: async () => {},
    getApproval: async () => ({ id: "a", kind: "command", details: {}, projectId: "p" }),
    resolveApproval: async () => {},
    getPlan: async () => [],
    getTask: async () => ({} as any),
    getTaskTree: async () => ({} as any),
  };
}

function typeText(stdin: any, text: string): void {
  for (const c of text) stdin.emit("keypress", c, { name: c, sequence: c });
}
function enter(stdin: any): void { stdin.emit("keypress", undefined, { name: "return" }); }
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }
function tab(stdin: any): void { stdin.emit("keypress", undefined, { name: "tab" }); }
function down(stdin: any): void { stdin.emit("keypress", undefined, { name: "down" }); }
function up(stdin: any): void { stdin.emit("keypress", undefined, { name: "up" }); }

describe("Interactive Mission Console: read-only commands during a running task", () => {
  it("/status runs immediately, shows its overlay, and does not interrupt the running task", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
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

    ctrlC(stdin);
    gate.end();
    await tick();
    ctrlC(stdin);
    await done;
  });

  it("/output runs immediately during a running task without disturbing it", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const getTask = vi.fn(async () => ({ task: { id: "task-1", status: "running" }, plan: [], events: [], agentStates: [], approvals: [], evidence: [], toolCalls: [], routing: null } as any));
    const backend: SessionBackend = { ...makeBackend(gate, () => {}), getTask };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "working" } } as any);
    await tick();

    typeText(stdin, "/output");
    enter(stdin);
    await tick();

    expect(getTask).toHaveBeenCalled();
    expect(app.snapshot().status).toBe("streaming"); // the running task is untouched

    ctrlC(stdin);
    gate.end();
    await tick();
    ctrlC(stdin);
    await done;
  });

  it("slash autocomplete opens and the selection scrolls with arrow keys while a task is running", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "working" } } as any);
    await tick();

    typeText(stdin, "/s");
    await tick();
    // The frame must show more than one candidate command starting with "s".
    const framed = io.writes.join("");
    expect(framed).toContain("/status");

    down(stdin);
    await tick();
    down(stdin);
    await tick();
    up(stdin);
    await tick();
    // Navigating the menu must not submit anything or disturb the task.
    expect(app.snapshot().status).toBe("streaming");

    ctrlC(stdin); // cancels the running task, arms exit-confirm
    gate.end();
    await tick();
    // Idle now, but "/s" is still in the buffer with its completion menu
    // open — Ctrl+C dismisses the menu, then clears the buffer, before the
    // already-armed exit-confirm can fire.
    ctrlC(stdin); // dismisses the completion menu
    ctrlC(stdin); // clears "/s"
    ctrlC(stdin); // exits
    await done;
  });
});

describe("Interactive Mission Console: /pause and /stop", () => {
  it("/pause requests cancellation without arming exit-confirm, and the task is resumable via /continue", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const cancel = vi.fn();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, cancel), now: () => Date.now(), maxFps: 120,
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

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(app.snapshot().notices.some((n) => n.text.toLowerCase().includes("pausing"))).toBe(true);

    // Ctrl+C right after /pause must NOT immediately exit — /pause never
    // armed the exit-confirm flag Ctrl+C uses.
    let resolved = false;
    void done.then(() => { resolved = true; });
    ctrlC(stdin);
    await tick();
    expect(resolved).toBe(false);

    gate.end();
    await tick();
    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("/stop cancels the task and reports what was preserved", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const cancel = vi.fn();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, cancel), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ id: "t1", sequence: 1, type: "tool.started", payload: { toolCallId: "t1", toolName: "read_file", argsJson: "{}" } } as any);
    gate.push({ id: "t2", sequence: 2, type: "tool.completed", payload: { toolCallId: "t1", status: "completed" } } as any);
    await tick();

    typeText(stdin, "/stop");
    enter(stdin);
    await tick();

    expect(cancel).toHaveBeenCalledTimes(1);
    const notices = app.snapshot().notices.map((n) => n.text);
    expect(notices.some((t) => t.toLowerCase().includes("stopping") && t.toLowerCase().includes("preserved"))).toBe(true);

    gate.end();
    await tick();
    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("/pause and /stop report they have nothing to do when idle", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "/pause");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.some((n) => n.text.includes("No running task to pause"))).toBe(true);

    typeText(stdin, "/stop");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.some((n) => n.text.includes("No running task to stop"))).toBe(true);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });
});

describe("Interactive Mission Console: truthful activity grammar", () => {
  it("renders a failed → recovering → passed story as ✗ then ↻ then ✓, never a green check on the failure", () => {
    let s = reduce(initialState(), { type: "session.started", meta });
    s = reduce(s, { type: "user.message", text: "run the tests" });

    // Stage 1: the test just failed — a bare, not-yet-retrying problem reads
    // as a failure (✗), never a warning or a check.
    s = reduce(s, { type: "recovery.problem", tool: "run_command", message: "missing.test.mjs · exit 1" });
    expect(s.recoveries).toHaveLength(1);
    const failedLine = stripAnsi(recoveryEntryLines(s.recoveries[0]!, plain, true, false)[0]!);
    expect(failedLine).toContain("✗");
    expect(failedLine).not.toContain("✓");

    // Stage 2: a strategy is chosen — now it's an *active* recovery (↻).
    s = reduce(s, { type: "recovery.strategy", tool: "run_command", strategy: "switching to value.test.mjs" });
    const retryingLines = recoveryEntryLines(s.recoveries[0]!, plain, true, false).map(stripAnsi);
    expect(retryingLines[0]).toContain("↻");
    expect(retryingLines[1]).toContain("switching to value.test.mjs");

    // Stage 3: the retried command passes — a distinct, separate ✓ action
    // line, and the recovery entry itself resolves to "recovered" (✓), never
    // silently reusing the earlier ✗/↻ line.
    s = reduce(s, { type: "tool.start", id: "verify", name: "run_command", purpose: "node --test value.test.mjs", verification: true });
    s = reduce(s, { type: "tool.end", id: "verify", status: "completed", summary: "exit 0" });
    expect(s.recoveries[0]!.status).toBe("recovered");
    const passLine = stripAnsi(actionLine(s.tools[0]!, plain, true)!);
    expect(passLine).toContain("✓");
    expect(passLine).toContain("node --test value.test.mjs");
  });
});

describe("Interactive Mission Console: final result rendering", () => {
  it("renders exactly one structured completion block on task completion", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "All done." } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const framed = io.writes.join("");
    const occurrences = (framed.match(/Task completed/g) ?? []).length;
    // Multiple repaints happen during a run; each repaint is a full-screen
    // clear+redraw, so counting raw substring hits across the whole byte
    // stream isn't meaningful — assert against the final, settled frame only.
    const lastFrameStart = framed.lastIndexOf("\x1b[H\x1b[K");
    const lastFrame = lastFrameStart >= 0 ? framed.slice(lastFrameStart) : framed;
    expect((lastFrame.match(/Task completed/g) ?? []).length).toBe(1);
    expect(occurrences).toBeGreaterThanOrEqual(1);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("wraps a long final answer instead of truncating it with an ellipsis", async () => {
    const io = new FakeTermIO();
    io.columns = 50;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    const longAnswer = "This is a deliberately long final answer sentence that must wrap across several lines instead of being cut short with an ellipsis.";
    gate.push({ type: "evidence.persisted", payload: { deltaText: longAnswer } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const framed = io.writes.join("");
    expect(framed).not.toContain("…");
    // The full sentence must be recoverable (word-wrapped, not dropped).
    for (const word of ["deliberately", "ellipsis."]) expect(framed).toContain(word);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });
});

describe("Interactive Mission Console: Mission/Activity body structure", () => {
  const opts = { columns: 80, rows: 30, tick: 0, promptLabel: "› ", promptWidth: 2 };
  const ctx = { commands: [], paletteItems: [] };

  it("states which mission is running once, under a Mission heading — not duplicated in the transcript", () => {
    let s = reduce(initialState(), { type: "session.started", meta });
    s = reduce(s, { type: "user.message", text: "fix the flaky retry logic" });
    const frame = composeApp(s, initialInputState(), plain, false, ctx, opts).lines.join("\n");
    expect(frame).toContain("Mission");
    expect(frame).toContain("fix the flaky retry logic");
    // Only one occurrence of the objective text — the Mission heading owns
    // it, the ordinary "you ›" transcript line does not also repeat it.
    const occurrences = (frame.match(/fix the flaky retry logic/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(frame).not.toContain("you ›");
  });

  it("wraps a very long mission objective instead of truncating it with an ellipsis", () => {
    let s = reduce(initialState(), { type: "session.started", meta });
    const longObjective = "Refactor the entire provider retry pipeline so it backs off exponentially, logs every attempt with full context, and never silently swallows a terminal error again";
    s = reduce(s, { type: "user.message", text: longObjective });
    const frame = composeApp(s, initialInputState(), plain, false, ctx, { ...opts, columns: 50 }).lines.join("\n");
    expect(frame).not.toContain("…");
    for (const word of ["Refactor", "exponentially,", "again"]) expect(frame).toContain(word);
  });

  it("labels the structured action log with an Activity heading only once there is activity to show", () => {
    let s = reduce(initialState(), { type: "session.started", meta });
    // Before any user message, there is no mission and nothing to label.
    const idleFrame = composeApp(s, initialInputState(), plain, false, ctx, opts).lines.join("\n");
    expect(idleFrame).not.toContain("Activity");

    s = reduce(s, { type: "user.message", text: "run the tests" });
    s = reduce(s, { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test" });
    s = reduce(s, { type: "tool.end", id: "t1", status: "completed", summary: "33 passed" });
    const activeFrame = composeApp(s, initialInputState(), plain, false, ctx, opts).lines.join("\n");
    expect(activeFrame).toContain("Activity");
    expect(activeFrame).toContain("pnpm test");
  });
});
