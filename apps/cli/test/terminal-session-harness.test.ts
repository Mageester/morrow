import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";

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

/** Fake raw stdin: an EventEmitter with the TTY methods the session touches. */
function fakeStdin(): any {
  const e = new EventEmitter() as any;
  e.isTTY = true;
  e.setRawMode = () => e;
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

/** A controllable SSE stream: push events, end it, and honour aborts. */
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

describe("interactive session: streaming, cancellation, resize", () => {
  it("rejects path-like and foreign /output references before fetching a task", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const getTask = vi.fn(async () => { throw new Error("must not fetch an unscoped task"); });
    const backend: SessionBackend = {
      ...makeBackend(gate, () => {}),
      getTask,
      listTasks: async () => [{ id: "safe-task-123", status: "completed", createdAt: "2026-07-11T00:00:00.000Z" } as any],
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "/output ../providers");
    enter(stdin);
    await tick();
    typeText(stdin, "/output foreign-task");
    enter(stdin);
    await tick();

    expect(getTask).not.toHaveBeenCalled();
    expect(app.snapshot().notices.map((notice) => notice.text).join("\n")).toMatch(/Invalid task reference|No task matches/);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("continues an interrupted task after its historical terminal-event cursor", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const subscribeAfter: Array<number | undefined> = [];
    let subscriptions = 0;
    const backend: SessionBackend = {
      ...makeBackend(new EventGate(), () => {}),
      subscribe: (async function* (_taskId: string, _signal: AbortSignal, after?: number) {
        subscribeAfter.push(after);
        subscriptions += 1;
        if (subscriptions === 1 || after === undefined) {
          yield { id: "event-5", sequence: 5, type: "task.interrupted", payload: { reason: "stalled" } } as any;
          return;
        }
        yield { id: "event-6", sequence: 6, type: "assistant.turn_started", payload: { turnId: "resumed" } } as any;
        yield { id: "event-7", sequence: 7, type: "evidence.persisted", payload: { turnId: "resumed", deltaText: "Resumed answer" } } as any;
        yield { id: "event-8", sequence: 8, type: "assistant.turn_completed", payload: { turnId: "resumed", final: true } } as any;
        yield { id: "event-9", sequence: 9, type: "task.completed", payload: {} } as any;
      }) as any,
      resume: vi.fn(async () => {}),
      getTask: async () => ({ events: [{ sequence: 5, type: "task.interrupted" }] } as any),
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "start work");
    enter(stdin);
    await tick();
    expect(app.snapshot().status).toBe("stalled");

    typeText(stdin, "/continue");
    enter(stdin);
    await tick();

    expect(subscribeAfter).toEqual([undefined, 5]);
    expect(app.snapshot().status).toBe("completed");
    expect(app.snapshot().conversation.at(-1)?.text).toBe("Resumed answer");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("streams assistant deltas into the transcript and completes", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "hi");
    enter(stdin);
    await tick();

    gate.push({ type: "evidence.persisted", payload: { deltaText: "Hello there" } } as any);
    await tick();
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const snap = app.snapshot();
    const assistant = snap.conversation.find((c) => c.role === "assistant");
    expect(assistant?.text).toContain("Hello there");
    expect(snap.status).toBe("completed");

    ctrlC(stdin); // empty line → arm exit
    ctrlC(stdin); // confirm exit
    await done;
  });

  it("Ctrl+C cancels a running task, then a second Ctrl+C exits", async () => {
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

    // First Ctrl+C while streaming → cancel requested, session stays alive.
    ctrlC(stdin);
    await tick();
    expect(cancel).toHaveBeenCalledTimes(1);

    let resolved = false;
    void done.then(() => { resolved = true; });
    await tick();
    expect(resolved).toBe(false); // did NOT exit on first Ctrl+C

    // Second Ctrl+C → exit.
    ctrlC(stdin);
    gate.end();
    await done;
    expect(resolved).toBe(true);
  });

  it("does not require a third Ctrl+C when cancellation completes between presses (P1-3 race)", async () => {
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

    // First Ctrl+C while streaming → cancel requested, arms exit-confirm.
    ctrlC(stdin);
    await tick();
    expect(cancel).toHaveBeenCalledTimes(1);

    // Cancellation completes FAST: the stream ends and `busy` flips back to
    // false BEFORE the user's next keypress — the exact race that used to
    // route the next Ctrl+C into a separate, unarmed idle exit-confirm flag.
    gate.end();
    await tick();

    let resolved = false;
    void done.then(() => { resolved = true; });

    // Second Ctrl+C, exactly as "Cancelling… (Ctrl+C again to exit)" said.
    // Must exit now — a third press should never be necessary.
    ctrlC(stdin);
    await done;
    expect(resolved).toBe(true);
  });

  it("busy keystrokes never silently disappear: one clear notice, no buffering (P1-1)", async () => {
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

    // Type a whole sentence while busy — none of it should land in the input
    // line (it never reaches the pure InputState/buffer, and never appears
    // anywhere in the rendered frame)...
    typeText(stdin, "this message should not silently disappear");
    await tick();
    const snap = app.snapshot();
    expect(snap.status).toBe("streaming");
    expect(io.writes.join("")).not.toContain("this message should not silently disappear");

    // ...and the user gets told exactly once, not once per keystroke.
    const busyNotices = snap.notices.filter((n) => n.text.includes("still working"));
    expect(busyNotices.length).toBe(1);

    ctrlC(stdin); // cancel
    gate.end();
    await tick();
    ctrlC(stdin); // exit (armed by the same flag the cancel used)
    await done;
  });

  it("recomposes on resize without corrupting the frame", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    typeText(stdin, "hi");
    await tick();

    const before = io.writes.length;
    io.columns = 40;
    io.rows = 12;
    io.emitResize();
    await tick();
    expect(io.writes.length).toBeGreaterThan(before); // a repaint happened

    ctrlC(stdin); // clear buffer
    ctrlC(stdin); // arm
    ctrlC(stdin); // exit
    await done;
  });
});
