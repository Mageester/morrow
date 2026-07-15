import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import type { ModelStatus, ModelBudgetView, ProviderStatus, RouteReasoningCapability } from "@morrow/contracts";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";
import { reduceKey, initialInputState, type KeyContext } from "../src/terminal/input-state.js";
import {
  reasoningOptions,
  renderReasoningPicker,
  reasoningStatusText,
  isReasoningCompatible,
  normalizeReasoningForRoute,
  formatBudget,
  buildModelPickerItems,
  filterModelItems,
  renderModelPicker,
} from "../src/terminal/index.js";
import { clipToWidth } from "../src/terminal/view.js";

const plain = new Output({ json: false, quiet: false, color: false });

const effortCap: RouteReasoningCapability = { control: "effort", efforts: ["low", "medium", "high"], budgets: [], source: "registry" };
const budgetCap: RouteReasoningCapability = { control: "budget", efforts: [], budgets: [2048, 8192, 16384], source: "provider-metadata" };
const fixedCap: RouteReasoningCapability = { control: "fixed", efforts: [], budgets: [], source: "registry" };
const noneCap: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "registry" };

function model(providerId: string, id: string, label: string, reasoning: RouteReasoningCapability, available = true, extra: Partial<ModelStatus["model"]> = {}): ModelStatus {
  return {
    available,
    model: {
      version: 1, id, canonicalId: id, aliases: [], providerId: providerId as any, label,
      contextWindow: 200000, maxOutputTokens: null, pricing: null, tokenUsage: true, streamingUsage: true,
      capabilities: { streaming: true, toolCalls: true, vision: false },
      speedClass: "balanced", costClass: "low", privacy: "remote", builtIn: true, reasoning, ...extra,
    },
  };
}
function provider(id: string, defaultModel: string | null, configured = true): ProviderStatus {
  return {
    version: 1, id: id as any, label: id, kind: "api-key", configured, available: configured,
    endpointType: "default", endpointHost: null, authStatus: configured ? "configured" : "missing",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: false, local: false },
    models: [], defaultModel, note: null, setupHint: "set the API key",
  };
}

// ── Pure reasoning logic ─────────────────────────────────────────────────────

describe("reasoning options reflect the route's real capability", () => {
  it("effort control offers Auto + the advertised levels only", () => {
    expect(reasoningOptions(effortCap).map((o) => o.arg)).toEqual(["auto", "low", "medium", "high"]);
    const lowOnly = reasoningOptions({ control: "effort", efforts: ["low"], budgets: [], source: "registry" });
    expect(lowOnly.map((o) => o.arg)).toEqual(["auto", "low"]);
  });
  it("budget control offers Auto, Off, and each budget", () => {
    expect(reasoningOptions(budgetCap).map((o) => o.label)).toEqual(["Auto", "Off", "2k", "8k", "16k"]);
  });
  it("none and fixed controls offer nothing to choose (informational only)", () => {
    expect(reasoningOptions(noneCap)).toEqual([]);
    expect(reasoningOptions(fixedCap)).toEqual([]);
  });
  it("formats budgets compactly", () => {
    expect(formatBudget(2048)).toBe("2k");
    expect(formatBudget(16384)).toBe("16k");
    expect(formatBudget(500)).toBe("500");
  });
});

describe("reasoning compatibility + safe normalization", () => {
  it("auto is compatible with every route", () => {
    for (const cap of [effortCap, budgetCap, fixedCap, noneCap]) {
      expect(isReasoningCompatible({ mode: "auto" }, cap)).toBe(true);
    }
  });
  it("an effort setting is incompatible with a budget or none route", () => {
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, effortCap)).toBe(true);
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, budgetCap)).toBe(false);
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, noneCap)).toBe(false);
  });
  it("resets an incompatible setting to Auto, flagging the change", () => {
    const kept = normalizeReasoningForRoute({ mode: "effort", effort: "high" }, effortCap);
    expect(kept).toEqual({ config: { mode: "effort", effort: "high" }, changed: false });
    const reset = normalizeReasoningForRoute({ mode: "effort", effort: "high" }, noneCap);
    expect(reset).toEqual({ config: { mode: "auto" }, changed: true });
  });
  it("summarizes the active reasoning for the status line", () => {
    expect(reasoningStatusText(undefined)).toBe("Auto");
    expect(reasoningStatusText({ mode: "effort", effort: "high" })).toBe("High");
    expect(reasoningStatusText({ mode: "budget", tokens: 16384 })).toBe("16k thinking");
    expect(reasoningStatusText({ mode: "off" })).toBe("Off");
  });
});

describe("reasoning selector rendering", () => {
  it("lists the supported levels and marks the current one", () => {
    const lines = renderReasoningPicker(effortCap, plain, { selected: 0, unicode: false, routeLabel: "GPT-5.5", current: { mode: "effort", effort: "high" } });
    const text = lines.join("\n");
    expect(text).toContain("Reasoning · GPT-5.5");
    expect(text).toContain("Auto");
    expect(text).toContain("High");
    expect(lines.some((l) => l.includes("*") && l.includes("High"))).toBe(true); // current marker
  });
  it("shows an honest informational panel for a fixed route, never a fake list", () => {
    const lines = renderReasoningPicker(fixedCap, plain, { selected: 0, unicode: false });
    expect(lines.join("\n")).toContain("Fixed by provider");
    expect(lines.join("\n")).not.toContain("Low");
  });
  it("says Not configurable for a route with no reasoning", () => {
    expect(renderReasoningPicker(noneCap, plain, { selected: 0, unicode: false }).join("\n")).toContain("Not configurable");
  });
});

// ── Reducer: Tab opens reasoning; selector nav + select ──────────────────────

describe("model-picker reducer: Tab opens reasoning for the highlighted model", () => {
  const models = [model("openai", "gpt-5.5", "GPT-5.5", effortCap), model("openai", "gpt-4o-mini", "GPT-4o mini", noneCap, false)];
  const items = buildModelPickerItems(models, [], [provider("openai", "gpt-5.5")]);
  const ctx: KeyContext = { commands: [], paletteItems: [], modelItems: items };

  it("Tab on an available model requests the reasoning overlay for that model", () => {
    const s0 = { ...initialInputState(), overlay: "model" as const, modelSelected: 1 }; // items[1] = gpt-5.5
    const { action } = reduceKey(s0, { name: "tab" }, ctx);
    expect(action).toEqual({ type: "open-reasoning", forModelId: "gpt-5.5" });
  });
  it("Tab on Auto (no reasoning route) is a no-op", () => {
    const s0 = { ...initialInputState(), overlay: "model" as const, modelSelected: 0 }; // items[0] = auto
    const { action } = reduceKey(s0, { name: "tab" }, ctx);
    expect(action).toEqual({ type: "none" });
  });
});

describe("reasoning selector reducer", () => {
  const ctx: KeyContext = { commands: [], paletteItems: [], reasoningCap: effortCap };
  function opened() {
    return { ...initialInputState(), overlay: "reasoning" as const, reasoningReturnsToModel: true };
  }
  it("arrows move within the supported options", () => {
    const { state } = reduceKey(opened(), { name: "down" }, ctx);
    expect(state.reasoningSelected).toBe(1);
  });
  it("Enter submits /reasoning <arg> for the highlighted option", () => {
    const s0 = { ...opened(), reasoningSelected: 3 }; // auto,low,medium,high -> high
    const { action } = reduceKey(s0, { name: "return" }, ctx);
    expect(action).toEqual({ type: "submit", value: "/reasoning high" });
  });
  it("Escape returns to the model picker when opened from it", () => {
    const { state } = reduceKey(opened(), { name: "escape" }, ctx);
    expect(state.overlay).toBe("model");
  });
  it("Escape closes entirely when opened directly via /reasoning", () => {
    const s0 = { ...initialInputState(), overlay: "reasoning" as const, reasoningReturnsToModel: false };
    const { state } = reduceKey(s0, { name: "escape" }, ctx);
    expect(state.overlay).toBe("none");
  });
  it("Enter is inert on a route with no options", () => {
    const noneCtx: KeyContext = { commands: [], paletteItems: [], reasoningCap: noneCap };
    const { action } = reduceKey(opened(), { name: "return" }, noneCtx);
    expect(action).toEqual({ type: "none" });
  });
});

// ── Compact picker: visual acceptance at required widths (mission spec §10) ───

describe("compact picker stays clean at 80/100/120/160 columns", () => {
  const models = [
    model("anthropic", "claude-sonnet", "Claude Sonnet 5", effortCap),
    model("openai", "gpt-5.6", "GPT-5.6", effortCap),
    model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", noneCap),
    model("openai-compatible", "north-mini-code-free", "North Mini Code", budgetCap, true, { costClass: "free" }),
  ];
  const items = buildModelPickerItems(models, [], []);
  const filtered = filterModelItems("", items);

  for (const columns of [80, 100, 120, 160]) {
    it(`no overflow, current model obvious, controls visible @ ${columns}`, () => {
      const lines = renderModelPicker(filtered, plain, { query: "", selected: 1, maxRows: 6, unicode: false, currentModelId: "claude-sonnet" });
      const clipped = lines.map((l) => clipToWidth(l, columns));
      for (const l of clipped) expect(l.length).toBeLessThanOrEqual(columns);
      const text = clipped.join("\n");
      expect(text).toContain("Select model");
      expect(text).toContain("Tab reasoning"); // controls visible
      expect(text).toContain("Claude Sonnet 5"); // current model obvious
    });
  }

  it("rows carry only name, provider, and state markers — no pricing/endpoint noise", () => {
    const lines = renderModelPicker(filtered, plain, { query: "", selected: 1, maxRows: 6, unicode: false, currentModelId: "claude-sonnet" });
    const rowLines = lines.filter((l) => l.includes("GPT-5.6") || l.includes("DeepSeek"));
    for (const l of rowLines) {
      expect(l).not.toMatch(/per M tok|\$|context|endpoint/i);
    }
  });

  it("the highlighted detail block is compact and route-explicit", () => {
    const idx = filtered.findIndex((i) => i.id === "north-mini-code-free");
    const lines = renderModelPicker(filtered, plain, { query: "", selected: idx, maxRows: 6, unicode: false });
    const text = lines.join("\n");
    expect(text).toContain("North Mini Code");
    expect(text).toContain("free");
    expect(text).toContain("Route: openai-compatible/north-mini-code-free");
  });
});

// ── End-to-end: atomic route (model + reasoning) through the real session ────

const meta: SessionMeta = {
  greeting: "hi", projectName: "M", workspacePath: "/w", branch: "main",
  provider: "auto", model: "auto", privacy: "local", mode: "Build · approvals required",
  memory: true, autoApprove: false,
};
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = true;
  private cbs: Array<() => void> = [];
  write(s: string): void { this.writes.push(s); }
  on(_e: "resize", cb: () => void): void { this.cbs.push(cb); }
  off(_e: "resize", cb: () => void): void { this.cbs = this.cbs.filter((c) => c !== cb); }
  all(): string { return this.writes.join(""); }
}
function fakeStdin(): any {
  const e = new EventEmitter() as any;
  e.isTTY = true; e.setRawMode = () => e; e.resume = () => e; e.pause = () => e;
  return e;
}
class EventGate {
  private waiters: Array<(r: IteratorResult<RawTaskEvent>) => void> = [];
  private ended = false;
  end(): void { this.ended = true; let w; while ((w = this.waiters.shift())) w({ value: undefined as any, done: true }); }
  async *iterate(signal: AbortSignal): AsyncIterable<RawTaskEvent> {
    while (true) {
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
    subscribe: (_t, signal) => gate.iterate(signal),
    cancel: async () => {}, resume: async () => {},
    getApproval: async () => ({ id: "a", kind: "command", details: {}, projectId: "p" }),
    resolveApproval: async () => {}, getPlan: async () => [], getTask: async () => ({} as any), getTaskTree: async () => ({} as any),
    ...overrides,
  };
}
const REG_MODELS: ModelStatus[] = [
  model("openai", "gpt-5.5", "GPT-5.5", effortCap),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", noneCap),
];
function makeApp(io: FakeTermIO, stdin: any) {
  const gate = new EventGate();
  const backend = makeBackend(gate, {
    listModels: async () => REG_MODELS,
    getModelBudgets: async () => [] as ModelBudgetView[],
    listProviders: async () => [provider("openai", "gpt-5.5"), provider("deepseek", "deepseek-chat")],
  });
  return new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
}
function typeText(stdin: any, text: string): void { for (const c of text) stdin.emit("keypress", c, { name: c, sequence: c }); }
function key(stdin: any, name: string): void { stdin.emit("keypress", undefined, { name }); }
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("/reasoning: atomic route through the real session", () => {
  it("/reasoning high sets reasoning on the current effort-capable route", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const app = makeApp(io, stdin); const done = app.run();
    typeText(stdin, "/model gpt-5.5"); key(stdin, "return"); await tick();
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    expect(app.snapshot().notices.at(-1)!.text).toContain("Reasoning set to High");
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("/reasoning high is rejected on a route that has no effort control", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const app = makeApp(io, stdin); const done = app.run();
    typeText(stdin, "/model deepseek-chat"); key(stdin, "return"); await tick();
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    const notice = app.snapshot().notices.at(-1)!.text;
    expect(notice).toContain("does not support");
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("switching to an incompatible model resets reasoning to Auto and discloses it", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const app = makeApp(io, stdin); const done = app.run();
    typeText(stdin, "/model gpt-5.5"); key(stdin, "return"); await tick();
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    typeText(stdin, "/model deepseek-chat"); key(stdin, "return"); await tick();
    const texts = app.snapshot().notices.map((n) => n.text);
    expect(texts.some((t) => t.includes("Reasoning changed from High to Auto"))).toBe(true);
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("escaping the reasoning overlay discards the staged model — a later /reasoning does not bind to it", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const app = makeApp(io, stdin); const done = app.run();
    typeText(stdin, "/model"); key(stdin, "return"); await tick();
    typeText(stdin, "gpt-5.5"); await tick();
    key(stdin, "tab"); await tick(); // stage gpt-5.5 for reasoning
    key(stdin, "escape"); await tick(); // back to picker — must discard the staged route
    key(stdin, "escape"); await tick(); // close the picker
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    // Current route is still Auto (unknown capability) — so this is rejected,
    // NOT silently applied to the abandoned gpt-5.5 selection.
    const notice = app.snapshot().notices.at(-1)!.text;
    expect(notice).toContain("does not support");
    expect(app.snapshot().notices.some((n) => n.text.includes("for GPT-5.5"))).toBe(false);
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("Tab in the picker opens reasoning, and choosing a level applies model + reasoning together", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const app = makeApp(io, stdin); const done = app.run();
    typeText(stdin, "/model"); key(stdin, "return"); await tick();
    typeText(stdin, "gpt-5.5"); await tick();
    key(stdin, "tab"); await tick();
    expect(app.inputSnapshot().overlay).toBe("reasoning");
    key(stdin, "down"); key(stdin, "down"); key(stdin, "down"); // auto->low->medium->high
    key(stdin, "return"); await tick();
    const texts = app.snapshot().notices.map((n) => n.text);
    expect(texts.some((t) => t.includes("Reasoning set to High") && t.includes("GPT-5.5"))).toBe(true);
    ctrlC(stdin); ctrlC(stdin); await done;
  });
});

// ── The chosen reasoning actually reaches the outbound send (no silent drop) ─

describe("/reasoning: the selected value reaches backend.send(), never silently dropped", () => {
  it("a real chat message send carries the configured reasoning through to SessionBackend.send()", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const gate = new EventGate();
    const captured: Array<{ text: string; opts: any }> = [];
    const backend = makeBackend(gate, {
      listModels: async () => REG_MODELS,
      getModelBudgets: async () => [] as ModelBudgetView[],
      listProviders: async () => [provider("openai", "gpt-5.5"), provider("deepseek", "deepseek-chat")],
      send: async (text, opts) => {
        captured.push({ text, opts });
        return { taskId: "task-1" };
      },
    });
    const app = new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
    const done = app.run();
    typeText(stdin, "/model gpt-5.5"); key(stdin, "return"); await tick();
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    typeText(stdin, "hello there"); key(stdin, "return"); await tick();
    gate.end();
    expect(captured.length).toBe(1);
    expect(captured[0]!.text).toBe("hello there");
    // This is the exact gap that made the picker/UI PR incomplete: the
    // selected reasoning must be present on the object handed to send(),
    // not just held in in-memory UI state nothing ever reads.
    expect(captured[0]!.opts.reasoning).toEqual({ mode: "effort", effort: "high" });
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("with no reasoning selected (Auto), send() carries no reasoning field", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const gate = new EventGate();
    const captured: Array<{ opts: any }> = [];
    const backend = makeBackend(gate, {
      listModels: async () => REG_MODELS,
      send: async (text, opts) => { captured.push({ opts }); return { taskId: "task-1" }; },
    });
    const app = new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
    const done = app.run();
    typeText(stdin, "hello"); key(stdin, "return"); await tick();
    gate.end();
    expect(captured[0]!.opts.reasoning).toBeUndefined();
    ctrlC(stdin); ctrlC(stdin); await done;
  });
});

// ── Display surfaces show reasoning: header meta, /status, /cost, /model current ─

describe("reasoning is visible on every user-facing route surface", () => {
  // /status's overlay is clipped to available rows, and the bordered startup
  // panel (shown until the first message starts a conversation) leaves little
  // room — so, exactly like the existing /status test suite, send one message
  // through to completion first to reach the compact live layout before
  // opening it.
  function makeAppWithGate(io: FakeTermIO, stdin: any) {
    const gate = new EventGate();
    const backend = makeBackend(gate, {
      listModels: async () => REG_MODELS,
      getModelBudgets: async () => [] as ModelBudgetView[],
      listProviders: async () => [provider("openai", "gpt-5.5"), provider("deepseek", "deepseek-chat")],
    });
    const app = new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
    return { app, gate };
  }
  async function pastStartup(stdin: any, gate: EventGate) {
    typeText(stdin, "go"); key(stdin, "return"); await tick();
    gate.end();
    await tick();
  }

  it("/status shows the resolved reasoning alongside the model", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const { app, gate } = makeAppWithGate(io, stdin); const done = app.run();
    typeText(stdin, "/model gpt-5.5"); key(stdin, "return"); await tick();
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    await pastStartup(stdin, gate);
    typeText(stdin, "/status"); key(stdin, "return"); await tick();
    expect(io.all()).toContain("reasoning");
    expect(io.all()).toContain("High");
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("/status shows Auto before any reasoning is configured", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const { app, gate } = makeAppWithGate(io, stdin); const done = app.run();
    await pastStartup(stdin, gate);
    typeText(stdin, "/status"); key(stdin, "return"); await tick();
    expect(io.all()).toContain("Auto");
    ctrlC(stdin); ctrlC(stdin); await done;
  });

  it("the header reflects the configured reasoning once set, and omits it at Auto", async () => {
    const io = new FakeTermIO(); const stdin = fakeStdin();
    const { app, gate } = makeAppWithGate(io, stdin); const done = app.run();
    typeText(stdin, "/model gpt-5.5"); key(stdin, "return"); await tick();
    await pastStartup(stdin, gate);
    io.writes = [];
    typeText(stdin, "/reasoning high"); key(stdin, "return"); await tick();
    expect(io.all()).toContain("reasoning High");
    ctrlC(stdin); ctrlC(stdin); await done;
  });
});
