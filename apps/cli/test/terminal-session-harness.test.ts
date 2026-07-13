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

  it("the input stays live while a task runs: typing is not blocked or dropped (Interactive Mission Console)", async () => {
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

    // Typing while the task is still streaming reaches the real input buffer
    // (not blocked) and is visible in the painted frame.
    typeText(stdin, "keep going");
    await tick();
    const snap = app.snapshot();
    expect(snap.status).toBe("streaming");
    expect(io.writes.join("")).toContain("keep going");
    // Never a stale "still working" interruption notice — the input itself
    // proves it's live.
    expect(snap.notices.some((n) => n.text.toLowerCase().includes("still working"))).toBe(false);

    // Ctrl+C still cancels the running task (unchanged behavior), then a
    // second Ctrl+C exits — persistent input doesn't change this contract.
    ctrlC(stdin);
    await tick();
    ctrlC(stdin);
    gate.end();
    await done;
  });

  it("ordinary text submitted while a task runs is queued as a redirect, shown distinctly, and sent once the task ends", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const sent: string[] = [];
    const backend: SessionBackend = {
      ...makeBackend(gate, () => {}),
      send: async (text) => {
        sent.push(text);
        return { taskId: `task-${sent.length}` };
      },
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "do work");
    enter(stdin);
    await tick();
    expect(sent).toEqual(["do work"]);

    typeText(stdin, "also fix the docs");
    enter(stdin);
    await tick();

    // Queued, not sent yet, and not silently discarded — visible in state and
    // in the painted frame, distinct from both a notice and the activity feed.
    expect(app.snapshot().queuedMessages).toEqual(["also fix the docs"]);
    expect(sent).toEqual(["do work"]);
    expect(io.writes.join("")).toContain("also fix the docs");

    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    // Once the running task ends, the queued redirect is sent as the next task.
    expect(sent).toEqual(["do work", "also fix the docs"]);
    expect(app.snapshot().queuedMessages).toEqual([]);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("slash commands run immediately while a task is streaming, never becoming a task message or a queued redirect", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const sent: string[] = [];
    const backend: SessionBackend = {
      ...makeBackend(gate, () => {}),
      send: async (text) => {
        sent.push(text);
        return { taskId: `task-${sent.length}` };
      },
    };
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

    typeText(stdin, "/status");
    enter(stdin);
    await tick();

    expect(app.snapshot().status).toBe("streaming"); // /status did not disturb the running task
    expect(app.snapshot().queuedMessages).toEqual([]); // never queued
    expect(sent).toEqual(["do work"]); // never sent as a task message

    ctrlC(stdin);
    gate.end();
    await tick();
    ctrlC(stdin);
    await done;
  });

  it("ingests the same source event id exactly once, even if the backend replays it (event integrity #1)", async () => {
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

    gate.push({ id: "evt-start-1", sequence: 1, type: "assistant.turn_started", payload: { turnId: "t1" } } as any);
    gate.push({ id: "evt-delta-1", sequence: 2, type: "evidence.persisted", payload: { deltaText: "Hello", turnId: "t1" } } as any);
    await tick();
    // A reconnect/replay resending the exact same source event must not
    // duplicate its effect on the transcript.
    gate.push({ id: "evt-delta-1", sequence: 2, type: "evidence.persisted", payload: { deltaText: "Hello", turnId: "t1" } } as any);
    await tick();
    gate.push({ id: "evt-end-1", sequence: 3, type: "assistant.turn_completed", payload: { turnId: "t1", final: true } } as any);
    gate.push({ id: "evt-done-1", sequence: 4, type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const snap = app.snapshot();
    const assistant = snap.conversation.find((c) => c.role === "assistant");
    expect(assistant?.text).toBe("Hello");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("dedupes id-less raw events by type:sequence fallback identity, same as output-report.ts", async () => {
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

    // A legacy/pre-identity backend event with no `id` field at all — must
    // still be deduped (by type:sequence), not silently un-deduped because
    // it lacks an id.
    gate.push({ sequence: 1, type: "assistant.turn_started", payload: { turnId: "legacy-turn" } } as any);
    gate.push({ sequence: 2, type: "evidence.persisted", payload: { deltaText: "Hi", turnId: "legacy-turn" } } as any);
    await tick();
    gate.push({ sequence: 2, type: "evidence.persisted", payload: { deltaText: "Hi", turnId: "legacy-turn" } } as any); // replay
    await tick();
    gate.push({ sequence: 3, type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const snap = app.snapshot();
    const assistant = snap.conversation.find((c) => c.role === "assistant");
    expect(assistant?.text).toBe("Hi");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("keeps every derived terminal event from one raw event together (recovery problem + strategy share one source id)", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "fix it");
    enter(stdin);
    await tick();

    // `patch.recovery_feedback` maps to TWO terminal events (recovery.problem
    // and recovery.strategy) sharing the same source event id. Both must be
    // applied — deduping the raw event once must not drop the second one.
    gate.push({
      id: "evt-recovery-1",
      sequence: 1,
      type: "patch.recovery_feedback",
      payload: { targetFile: "a.js", conflictCategory: "context_mismatch", instruction: "Regenerate the patch." },
    } as any);
    await tick();
    gate.push({ id: "evt-applied-1", sequence: 2, type: "evidence.persisted", payload: { path: "a.js", size: 10, action: "patched" } } as any);
    gate.push({ id: "evt-done-1", sequence: 3, type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    const snap = app.snapshot();
    expect(snap.recoveries).toHaveLength(1);
    expect(snap.recoveries[0]).toMatchObject({ file: "a.js", strategy: "Regenerate the patch.", status: "recovered" });

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("a second task's id-less legacy events are not dropped as replays of the first task's (event integrity #4)", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    let sendCalls = 0;
    const backend: SessionBackend = {
      ...makeBackend(new EventGate(), () => {}),
      send: async () => {
        sendCalls += 1;
        return { taskId: `task-${sendCalls}` };
      },
      // No `id` field anywhere — a legacy/pre-identity backend. Both tasks'
      // event streams reuse the exact same type:sequence pairs, since
      // per-task sequence numbering restarts at 1 for every new task.
      subscribe: (async function* (taskId: string) {
        const label = taskId === "task-1" ? "Hello" : "World";
        yield { sequence: 1, type: "assistant.turn_started", payload: { turnId: taskId } } as any;
        yield { sequence: 2, type: "evidence.persisted", payload: { deltaText: label, turnId: taskId } } as any;
        yield { sequence: 3, type: "task.completed", payload: {} } as any;
      }) as any,
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "first");
    enter(stdin);
    await tick();

    typeText(stdin, "second");
    enter(stdin);
    await tick();

    const assistantTexts = app.snapshot().conversation.filter((c) => c.role === "assistant").map((c) => c.text);
    // Without task-scoping, task 2's `evidence.persisted:2` would be
    // silently dropped as an apparent replay of task 1's, leaving "World"
    // missing from the transcript entirely.
    expect(assistantTexts).toEqual(["Hello", "World"]);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("reconnect after resuming an interrupted task never re-applies an event already seen this session (event integrity #3)", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    let subscriptions = 0;
    const backend: SessionBackend = {
      ...makeBackend(new EventGate(), () => {}),
      subscribe: (async function* (_taskId: string, _signal: AbortSignal, after?: number) {
        subscriptions += 1;
        if (subscriptions === 1 || after === undefined) {
          yield { id: "evt-a", sequence: 5, type: "evidence.persisted", payload: { deltaText: "partial", turnId: "t1" } } as any;
          yield { id: "evt-b", sequence: 6, type: "task.interrupted", payload: { reason: "stalled" } } as any;
          return;
        }
        // Reconnect: the backend legitimately resends the last event at/near
        // the resume cursor before continuing with genuinely new ones.
        yield { id: "evt-b", sequence: 6, type: "task.interrupted", payload: { reason: "stalled" } } as any;
        yield { id: "evt-b2", sequence: 7, type: "assistant.turn_started", payload: { turnId: "t1" } } as any;
        yield { id: "evt-c", sequence: 8, type: "assistant.turn_completed", payload: { turnId: "t1", final: true, text: "final" } } as any;
        yield { id: "evt-d", sequence: 9, type: "task.completed", payload: {} } as any;
      }) as any,
      resume: vi.fn(async () => {}),
      getTask: async () => ({ events: [{ id: "evt-a", sequence: 5 }, { id: "evt-b", sequence: 6 }] } as any),
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

    expect(app.snapshot().status).toBe("completed");
    // Exactly one assistant entry (turnId t1) — the resent "stalled" event
    // must not have reopened or duplicated anything.
    expect(app.snapshot().conversation.filter((c) => c.role === "assistant")).toHaveLength(1);

    ctrlC(stdin);
    ctrlC(stdin);
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

describe("paused-state and YOLO notice consistency (consumer defects #5, #6)", () => {
  it("never shows a 'still working' interruption notice — the input stays live, so there is nothing to apologize for", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "go");
    enter(stdin);
    await tick();

    // A keystroke while busy reaches the real input buffer — it is not
    // blocked, so there is no "not applied yet" notice to show.
    typeText(stdin, "x");
    await tick();
    expect(app.snapshot().notices.some((n) => n.text.toLowerCase().includes("still working"))).toBe(false);

    // The task pauses (budget reached) — the stream just stops.
    gate.push({ type: "task.interrupted", payload: { reason: "turn_budget_reached" } } as any);
    gate.end();
    await tick();

    expect(app.snapshot().status).toBe("budget-reached");
    expect(app.snapshot().notices.some((n) => n.text.toLowerCase().includes("still working"))).toBe(false);

    // The "x" typed while busy is still sitting in the (now idle) input
    // line — persistent input means it was never blocked, but it also was
    // never submitted, so it's still there to clear before exit-confirm arms.
    ctrlC(stdin); // clears "x"
    ctrlC(stdin); // arms exit-confirm
    ctrlC(stdin); // exits
    await done;
  });

  it("never shows a stale YOLO on/off notice beside the current one after toggling twice", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "/yolo on");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.some((n) => n.text.startsWith("YOLO on"))).toBe(true);

    typeText(stdin, "/yolo off");
    enter(stdin);
    await tick();

    const texts = app.snapshot().notices.map((n) => n.text);
    // Only the latest toggle's notice remains — the earlier "on" claim,
    // which now contradicts the current "off" state, is gone.
    expect(texts.filter((t) => t.startsWith("YOLO on"))).toHaveLength(0);
    expect(texts.filter((t) => t.startsWith("YOLO off"))).toHaveLength(1);
    // The authoritative state (settings/meta) agrees.
    expect(app.snapshot().meta?.autoApprove).toBe(false);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("/panic's forced YOLO-off notice supersedes an earlier 'on' notice too", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate, () => {}), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "/yolo on");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.some((n) => n.text.startsWith("YOLO on"))).toBe(true);

    typeText(stdin, "/panic");
    enter(stdin);
    await tick();

    const texts = app.snapshot().notices.map((n) => n.text);
    expect(texts.filter((t) => t.startsWith("YOLO on"))).toHaveLength(0);
    expect(texts.some((t) => t.startsWith("Panic stop:"))).toBe(true);
    expect(app.snapshot().meta?.autoApprove).toBe(false);

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });
});

describe("approval rendering (consumer defect #1: unbound Output color-method crash)", () => {
  function approvalBackend(overrides: Partial<SessionBackend> & { gate?: EventGate } = {}): SessionBackend {
    const { gate, ...rest } = overrides;
    return {
      ...makeBackend(gate ?? new EventGate(), () => {}),
      getApproval: async (id: string) => ({
        id, kind: "command",
        details: { executable: "rm", args: ["-rf", "build"], risk: "medium", purpose: "clean the build directory" },
        projectId: "p",
      }),
      resolveApproval: async () => {},
      ...rest,
    };
  }

  it("renders a command approval at every risk level without the unbound Output color-method crash (reproduces the original stack trace pre-fix)", async () => {
    for (const risk of ["low", "medium", "high"] as const) {
      const io = new FakeTermIO();
      const stdin = fakeStdin();
      const gate = new EventGate();
      const resolved: Array<{ id: string; decision: string; trust?: string | undefined }> = [];
      const app = new InteractiveSession({
        io, stdin, out: plain, unicode: false, meta, settings,
        backend: approvalBackend({
          gate,
          getApproval: async (id: string) => ({
            id, kind: "command",
            details: { executable: "rm", args: ["-rf", "build"], risk, purpose: "clean the build directory" },
            projectId: "p",
          }),
          resolveApproval: async (id: string, decision: string, trust?: string) => { resolved.push({ id, decision, trust }); },
        }),
        now: () => Date.now(), maxFps: 120,
      });
      const done = app.run();

      typeText(stdin, "clean up");
      enter(stdin);
      await tick();

      gate.push({ type: "approval.requested", payload: { approvalId: `a-${risk}`, kind: "command" } } as any);
      await tick();

      // Before the fix, `out[riskColor(risk)]` extracted a color method off
      // the Output instance and called it with no receiver, throwing
      // "Cannot read properties of undefined (reading 'wrap')" from inside
      // paint(). runTask's catch converted that into a silent task.failed
      // instead of ever showing the approval prompt, for every risk level
      // (the extraction lost `this` regardless of which color was picked).
      expect(app.snapshot().status).not.toBe("failed");
      expect(app.snapshot().lastError).toBeUndefined();
      const rendered = io.writes.join("");
      expect(rendered).toContain("Command approval");
      expect(rendered.toLowerCase()).toContain(`${risk} risk`);

      // Still fully interactive: approving reaches the backend.
      stdin.emit("keypress", "y", { name: "y", str: "y" });
      await tick();
      expect(resolved).toContainEqual({ id: `a-${risk}`, decision: "allow_once", trust: undefined });

      gate.push({ type: "task.completed", payload: {} } as any);
      gate.end();
      await tick();
      expect(app.snapshot().status).toBe("completed");

      ctrlC(stdin);
      ctrlC(stdin);
      await done;
    }
  });

  it("renders command-approval risk colors in --color mode without crashing", async () => {
    const colorOut = new Output({ json: false, quiet: false, color: true });
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: colorOut, unicode: false, meta, settings,
      backend: approvalBackend({ gate }), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "clean up");
    enter(stdin);
    await tick();
    gate.push({ type: "approval.requested", payload: { approvalId: "a1", kind: "command" } } as any);
    await tick();

    expect(app.snapshot().status).not.toBe("failed");
    const rendered = io.writes.join("");
    expect(rendered).toContain("Command approval");
    expect(rendered).toContain("\x1b[33m"); // ANSI yellow, applied via out.colorize, not a bare method reference

    stdin.emit("keypress", "n", { name: "n", str: "n" });
    await tick();
    gate.push({ type: "task.cancelled", payload: {} } as any);
    gate.end();
    await tick();

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("renders a patch approval without crashing", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: approvalBackend({
        gate,
        getApproval: async (id: string) => ({
          id, kind: "change_set",
          details: { files: ["a.js", "b.js"], explanation: "fix the bug", additions: 5, deletions: 2, diff: "--- a/a.js\n+++ b/a.js\n" },
          projectId: "p",
        }),
      }),
      now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "fix it");
    enter(stdin);
    await tick();
    gate.push({ type: "approval.requested", payload: { approvalId: "p1", kind: "change_set" } } as any);
    await tick();

    expect(app.snapshot().status).not.toBe("failed");
    const rendered = io.writes.join("");
    expect(rendered).toContain("Patch approval");
    expect(rendered).toContain("a.js, b.js");

    stdin.emit("keypress", "y", { name: "y", str: "y" });
    await tick();
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();
    expect(app.snapshot().status).toBe("completed");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("deny, session-trust, and pattern-trust approval keys all resolve correctly without crashing", async () => {
    const decisions: Array<["n" | "s" | "p", string]> = [
      ["n", "deny"],
      ["s", "trust_session"],
      ["p", "trust_project"],
    ];
    for (const [key, expectedDecision] of decisions) {
      const io = new FakeTermIO();
      const stdin = fakeStdin();
      const gate = new EventGate();
      const resolved: Array<{ id: string; decision: string; trust?: string | undefined }> = [];
      const app = new InteractiveSession({
        io, stdin, out: plain, unicode: false, meta, settings,
        backend: approvalBackend({
          gate,
          getApproval: async (id: string) => ({
            id, kind: "command",
            details: { executable: "git", args: ["push", "--force"], risk: "high", pattern: "git push --force", purpose: "sync" },
            projectId: "p",
          }),
          resolveApproval: async (id: string, decision: string, trust?: string) => { resolved.push({ id, decision, trust }); },
        }),
        now: () => Date.now(), maxFps: 120,
      });
      const done = app.run();

      typeText(stdin, "sync branch");
      enter(stdin);
      await tick();
      gate.push({ type: "approval.requested", payload: { approvalId: "a1", kind: "command" } } as any);
      await tick();
      expect(app.snapshot().status).not.toBe("failed");

      stdin.emit("keypress", key, { name: key, str: key });
      await tick();
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.decision).toBe(expectedDecision);
      if (expectedDecision !== "deny") expect(resolved[0]!.trust).toBe("git push --force");

      gate.push({ type: "task.cancelled", payload: {} } as any);
      gate.end();
      await tick();

      ctrlC(stdin);
      ctrlC(stdin);
      await done;
    }
  });

  it("survives a resize and timer-driven repaint while an approval is visible", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: approvalBackend({ gate }), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "clean up");
    enter(stdin);
    await tick();
    gate.push({ type: "approval.requested", payload: { approvalId: "a1", kind: "command" } } as any);
    await tick();
    expect(app.snapshot().status).not.toBe("failed");

    const before = io.writes.length;
    io.columns = 40;
    io.rows = 12;
    io.emitResize();
    await tick(); // a deferred timer repaint also fires within this window
    expect(io.writes.length).toBeGreaterThan(before);
    expect(app.snapshot().status).not.toBe("failed");
    expect(io.writes.join("")).toContain("Command approval");

    stdin.emit("keypress", "y", { name: "y", str: "y" });
    await tick();
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });
});
