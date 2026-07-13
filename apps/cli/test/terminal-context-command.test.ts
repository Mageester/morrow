import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";

/**
 * /context and /status model/limit truthfulness (consumer defect #4).
 *
 * Before the fix, both commands recomputed `usedTokens/maxTokens` directly
 * from `state.contextUsage.maxTokens` — a field that task-event-adapter.ts
 * resets to 0 on nearly every `context.exact_count_used`/`estimate_used`
 * event (the per-turn token-count signal), and that in any case only ever
 * held the *input budget* (post-reservation-margin), never the real
 * per-model context window. They also displayed `this.meta.provider/model`
 * — the configured value, which stays "auto"/"auto" forever in a session
 * that never pinned a model, instead of the actually-routed one.
 */

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
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }

async function runNoticeCommand(events: RawTaskEvent[], command: string): Promise<{ notices: string[]; io: FakeTermIO }> {
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

  typeText(stdin, command);
  enter(stdin);
  await tick();

  const notices = app.snapshot().notices.map((n) => n.text);
  ctrlC(stdin);
  ctrlC(stdin);
  await done;
  return { notices, io };
}

describe("/context and /status: model and context-limit truthfulness", () => {
  it("shows the actually-routed DeepSeek provider/model and its real known context window", async () => {
    const { notices } = await runNoticeCommand(
      [
        {
          type: "context.budget_calculated",
          payload: { maxInputTokens: 800000, contextWindowTokens: 1000000, contextWindowSource: "known-model" },
        } as any,
        {
          type: "provider.usage",
          payload: { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 120000, outputTokens: 5000 },
        } as any,
        { type: "context.exact_count_used", payload: { tokens: 130000, exact: true } } as any,
      ],
      "/context",
    );
    const line = notices.find((n) => n.startsWith("Context:"));
    expect(line).toBeDefined();
    expect(line).toContain("deepseek/deepseek-v4-pro");
    expect(line).toContain("130000/1000000 tokens (13%)");
    expect(line).toContain("exact");
  });

  it("displays 'limit unknown' honestly for a model the registry cannot assert a window for, instead of a guessed number", async () => {
    const { notices } = await runNoticeCommand(
      [
        {
          type: "context.budget_calculated",
          payload: { maxInputTokens: 32768, contextWindowTokens: 0, contextWindowSource: "fallback" },
        } as any,
        {
          type: "provider.usage",
          payload: { provider: "deepseek", model: "deepseek-chat", inputTokens: 4000, outputTokens: 200 },
        } as any,
        { type: "context.estimate_used", payload: { tokens: 4200 } } as any,
      ],
      "/context",
    );
    const line = notices.find((n) => n.startsWith("Context:"));
    expect(line).toBeDefined();
    expect(line).toContain("deepseek/deepseek-chat");
    expect(line).toContain("4200 tokens (limit unknown)");
    // Must not silently substitute the fallback input budget (32768) as if
    // it were the model's real context window.
    expect(line).not.toContain("32768");
  });

  it("used/max/percent never contradict each other after a mid-turn token-count event resets the internal maxTokens field to 0", async () => {
    const { notices } = await runNoticeCommand(
      [
        {
          type: "context.budget_calculated",
          payload: { maxInputTokens: 100000, contextWindowTokens: 128000, contextWindowSource: "known-model" },
        } as any,
        // This event type is the one that used to clobber `maxTokens` to 0.
        { type: "context.exact_count_used", payload: { tokens: 16000, exact: true } } as any,
        { type: "provider.usage", payload: { provider: "openai", model: "gpt-5.4", inputTokens: 16000, outputTokens: 300 } } as any,
      ],
      "/context",
    );
    const line = notices.find((n) => n.startsWith("Context:"))!;
    expect(line).toContain("16000/128000 tokens (13%)");
    expect(line).not.toContain("/0 tokens");
    expect(line).not.toContain("(0%)");
  });

  it("reflects a later routed/switched model on the next /context call, not the first turn's model forever", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    let sendCalls = 0;
    const gates: Record<string, EventGate> = { "task-1": new EventGate(), "task-2": new EventGate() };
    const backend: SessionBackend = {
      ...makeBackend(new EventGate()),
      send: async () => { sendCalls += 1; return { taskId: `task-${sendCalls}` }; },
      subscribe: (taskId, signal) => gates[taskId]!.iterate(signal),
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "go");
    enter(stdin);
    await tick();
    gates["task-1"]!.push({ type: "context.budget_calculated", payload: { maxInputTokens: 100000, contextWindowTokens: 128000, contextWindowSource: "known-model" } } as any);
    gates["task-1"]!.push({ type: "provider.usage", payload: { provider: "openai", model: "gpt-5.4-mini", inputTokens: 1000, outputTokens: 50 } } as any);
    gates["task-1"]!.push({ type: "task.completed", payload: {} } as any);
    gates["task-1"]!.end();
    await tick();

    typeText(stdin, "/context");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.at(-1)!.text).toContain("openai/gpt-5.4-mini");

    // A fresh task routes (or the user explicitly switches) to a different model.
    typeText(stdin, "continue with something else");
    enter(stdin);
    await tick();
    gates["task-2"]!.push({ type: "provider.usage", payload: { provider: "anthropic", model: "claude-3-5-sonnet-20241022", inputTokens: 2000, outputTokens: 80 } } as any);
    gates["task-2"]!.push({ type: "task.completed", payload: {} } as any);
    gates["task-2"]!.end();
    await tick();

    typeText(stdin, "/context");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.at(-1)!.text).toContain("anthropic/claude-3-5-sonnet-20241022");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("uses the resolved routing model when a task reports context before any provider usage", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: {
        ...makeBackend(gate),
        send: async () => ({
          taskId: "task-1",
          routing: { provider: "deepseek", model: "deepseek-v4-pro", preset: "balanced", fallback: false, overridden: false, privacy: "cloud" },
        }),
      },
      now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();

    typeText(stdin, "go");
    enter(stdin);
    await tick();
    gate.push({ type: "context.budget_calculated", payload: { maxInputTokens: 800000, contextWindowTokens: 1000000, contextWindowSource: "known-model" } } as any);
    gate.push({ type: "context.exact_count_used", payload: { tokens: 120000, exact: true } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    typeText(stdin, "/context");
    enter(stdin);
    await tick();

    expect(app.snapshot().notices.at(-1)!.text).toContain("deepseek/deepseek-v4-pro");
    expect(app.snapshot().notices.at(-1)!.text).toContain("120000/1000000 tokens (12%)");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });

  it("/status shows the identical model and context numbers as /context — the two can never disagree", async () => {
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
    gate.push({ type: "context.budget_calculated", payload: { maxInputTokens: 100000, contextWindowTokens: 128000, contextWindowSource: "known-model" } } as any);
    gate.push({ type: "provider.usage", payload: { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 5000, outputTokens: 100 } } as any);
    gate.push({ type: "context.exact_count_used", payload: { tokens: 5000, exact: true } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    typeText(stdin, "/context");
    enter(stdin);
    await tick();
    const contextNotice = app.snapshot().notices.at(-1)!.text;

    typeText(stdin, "/status");
    enter(stdin);
    await tick();
    const statusRendered = io.writes.join("");

    expect(contextNotice).toContain("deepseek/deepseek-v4-flash");
    expect(contextNotice).toContain("5000/128000 tokens (4%)");
    expect(statusRendered).toContain("deepseek/deepseek-v4-flash");
    expect(statusRendered).toContain("5000/128000 tokens (4%)");

    ctrlC(stdin);
    ctrlC(stdin);
    await done;
  });
});
