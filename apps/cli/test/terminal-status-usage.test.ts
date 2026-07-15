import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";

/**
 * Premium live status (mission spec §3): CURRENT REQUEST and CUMULATIVE
 * SESSION must render as visibly distinct sections, and an incomplete cache
 * breakdown must read as a stated total plus an honest lower bound — never
 * a confident-looking fresh/cached split that isn't backed by real provider
 * data. Exercises the real InteractiveSession command handling and reducer,
 * not an isolated formatting helper.
 */

const plain = new Output({ json: false, quiet: false, color: false });
const tick = () => new Promise((r) => setTimeout(r, 20));

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 100;
  rows = 45;
  isTTY = true;
  private cbs: Array<() => void> = [];
  write(s: string): void { this.writes.push(s); }
  on(_e: "resize", cb: () => void): void { this.cbs.push(cb); }
  off(_e: "resize", cb: () => void): void { this.cbs = this.cbs.filter((c) => c !== cb); }
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

const meta: SessionMeta = {
  greeting: "hi", projectName: "M", workspacePath: "/w", branch: "main",
  provider: "auto", model: "auto", privacy: "local", mode: "Build · approvals required",
  memory: true, autoApprove: false,
};
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

function makeBackend(gate: EventGate): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: (_taskId, signal) => gate.iterate(signal),
    cancel: async () => {},
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
function escape(stdin: any): void { stdin.emit("keypress", undefined, { name: "escape" }); }
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }

async function runStatus(events: RawTaskEvent[]): Promise<{ frame: string; io: FakeTermIO }> {
  const io = new FakeTermIO();
  const stdin = fakeStdin();
  const gate = new EventGate();
  const app = new InteractiveSession({
    io, stdin, out: plain, unicode: false, meta, settings,
    backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
  });
  const done = app.run();

  typeText(stdin, "go");
  enter(stdin);
  await tick();
  for (const ev of events) gate.push(ev);
  gate.push({ type: "task.completed", payload: {} } as any);
  gate.end();
  await tick();

  typeText(stdin, "/status");
  enter(stdin);
  await tick();
  const frame = io.all();
  escape(stdin);
  ctrlC(stdin); ctrlC(stdin);
  await done;
  return { frame, io };
}

describe("/status: CURRENT REQUEST vs CUMULATIVE SESSION", () => {
  it("renders both sections as visibly distinct labels", async () => {
    const { frame } = await runStatus([
      { type: "provider.usage", payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 5000, outputTokens: 200 } } as any,
    ]);
    expect(frame).toContain("CURRENT REQUEST");
    expect(frame).toContain("CUMULATIVE SESSION");
  });

  it("never displays cumulative task tokens as though they were one request's", async () => {
    // Two provider responses fold into a cumulative total that must differ
    // from the second (most recent/current) response's own numbers.
    const { frame } = await runStatus([
      { type: "provider.usage", sequence: 1, payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 40000, outputTokens: 1000 } } as any,
      { type: "provider.usage", sequence: 2, payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 9000, outputTokens: 300 } } as any,
    ]);
    // Cumulative section shows the true sum (49,000), current shows only
    // the latest response (9,000) — the two must never read identically.
    expect(frame).toContain("49k");
    expect(frame).toContain("9k");
    const currentIdx = frame.indexOf("CURRENT REQUEST");
    const cumulativeIdx = frame.indexOf("CUMULATIVE SESSION");
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    expect(cumulativeIdx).toBeGreaterThan(currentIdx);
  });

  it("displays an incomplete cache breakdown honestly — a stated total plus an explicit lower bound, never a fabricated split", async () => {
    const { frame } = await runStatus([
      // Reports a cache subtotal on this response, but the cumulative
      // total (only this one response) is still "complete" here — verify
      // the *incomplete* case with a second response that omits it.
      { type: "provider.usage", sequence: 1, payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 32000, outputTokens: 500, cachedInputTokens: 32000 } } as any,
      { type: "provider.usage", sequence: 2, payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 52000, outputTokens: 800 } } as any, // no cache field reported
    ]);
    expect(frame).toContain("cache breakdown: incomplete");
    expect(frame).toContain("known cached: ≥32k");
    // Never a confident-looking fresh/cached split for the incomplete total.
    expect(frame).not.toMatch(/cached: 32k\s+fresh/i);
  });

  it("displays a complete cache breakdown as a real fresh/cached split", async () => {
    const { frame } = await runStatus([
      { type: "provider.usage", payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 84000, outputTokens: 500, cachedInputTokens: 32000 } } as any,
    ]);
    expect(frame).toContain("fresh: 52k");
    expect(frame).toContain("cached: 32k");
    expect(frame).not.toContain("cache breakdown: incomplete");
  });

  it("shows the active task state alongside usage", async () => {
    const { frame } = await runStatus([
      { type: "provider.usage", payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 1000, outputTokens: 50 } } as any,
    ]);
    expect(frame).toMatch(/task\s+completed/);
  });
});

describe("/context and /status share the same canonical values", () => {
  it("the current provider request tokens shown by /context match the CURRENT REQUEST section in /status", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "go");
    enter(stdin);
    await tick();
    gate.push({
      type: "context.budget_calculated",
      payload: {
        contextWindowTokens: 128000, contextWindowSource: "model-metadata", contextWindowConfidence: "verified",
        outputReserveTokens: 2048, usableInputTokens: 100000, currentRequestTokens: 12000,
      },
    } as any);
    gate.push({ type: "provider.usage", payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 12000, outputTokens: 400 } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    typeText(stdin, "/context");
    enter(stdin);
    await tick();
    const contextFrame = io.all();
    expect(contextFrame).toContain("Current provider request: 12,000");
    escape(stdin);

    typeText(stdin, "/status");
    enter(stdin);
    await tick();
    const statusFrame = io.all();
    expect(statusFrame).toContain("CURRENT REQUEST");
    expect(statusFrame).toContain("12k");

    escape(stdin);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });
});
