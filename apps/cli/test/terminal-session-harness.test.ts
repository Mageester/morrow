import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";

const plain = new Output({ json: false, quiet: false, color: false });
const tick = () => new Promise((r) => setTimeout(r, 2));

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
    getOutput: async () => [],
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
