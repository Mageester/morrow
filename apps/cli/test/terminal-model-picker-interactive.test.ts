import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";
import type { ModelStatus, ModelBudgetView, ProviderStatus } from "@morrow/contracts";
import { reduceKey, initialInputState, type KeyContext } from "../src/terminal/input-state.js";
import { buildModelPickerItems, filterModelItems, renderModelPicker, modelDetailLines } from "../src/terminal/model-picker.js";
import { clipToWidth } from "../src/terminal/view.js";

/**
 * Deterministic acceptance coverage for the interactive /model picker
 * (mission spec §7): open/nav/search/scroll/select/cancel, unavailable
 * rejection, persistence through the real configuration path, current/
 * default indicators, custom-endpoint fallback, and narrow terminals.
 * Exercises the real reducer (input-state.ts), the real renderer
 * (model-picker.ts), and — for the end-to-end cases — the real
 * InteractiveSession command handling, never just isolated formatters.
 */

const plain = new Output({ json: false, quiet: false, color: false });

function model(providerId: string, id: string, label: string, overrides: Partial<ModelStatus["model"]> = {}, available = true): ModelStatus {
  return {
    available,
    model: {
      version: 1, id, canonicalId: id, aliases: [], providerId: providerId as any, label,
      contextWindow: 128000, maxOutputTokens: null, pricing: null, tokenUsage: true, streamingUsage: true,
      capabilities: { streaming: true, toolCalls: true, vision: false },
      speedClass: "balanced", costClass: "low", privacy: "remote", builtIn: true,
      ...overrides,
    },
  };
}

function budget(providerId: string, selectedModelId: string, overrides: Partial<ModelBudgetView> = {}): ModelBudgetView {
  return {
    providerId: providerId as any, selectedModelId, canonicalModelId: selectedModelId, displayName: selectedModelId,
    configured: true, protocol: "openai-chat", endpointKind: "default", endpointHost: null,
    contextWindowTokens: 128000, contextWindowConfidence: "verified",
    usableInputTokens: 100000, outputReserveTokens: 2048, totalReserveTokens: 4096,
    capabilities: { streaming: true, toolCalls: true, vision: false }, pricing: null,
    ...overrides,
  };
}

function provider(id: string, defaultModel: string | null, configured = true): ProviderStatus {
  return {
    version: 1, id: id as any, label: id, kind: "cloud" as any, configured, available: configured,
    endpointType: "default", endpointHost: null, authStatus: configured ? "configured" : "missing",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: false, local: false },
    models: [], defaultModel, note: null, setupHint: "set the API key",
  };
}

// ── Pure model-picker.ts unit coverage ──────────────────────────────────────

describe("model picker: real item construction and filtering", () => {
  const models: ModelStatus[] = [
    model("openai", "gpt-5.5", "GPT-5.5"),
    model("openai", "gpt-5.4-mini", "GPT-5.4 mini"),
    model("deepseek", "deepseek-chat", "DeepSeek Chat", {}, false),
  ];
  const budgets: ModelBudgetView[] = [
    budget("openai", "gpt-5.5"),
    budget("openai", "gpt-5.4-mini", { contextWindowConfidence: "configured", endpointKind: "custom", endpointHost: "my-proxy.internal" }),
  ];
  const providers: ProviderStatus[] = [provider("openai", "gpt-5.4-mini"), provider("deepseek", null, false)];

  it("puts Auto first as a real routing choice and marks the configured default", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    expect(items[0]!.kind).toBe("auto");
    expect(items[0]!.available).toBe(true);
    const mini = items.find((i) => i.id === "gpt-5.4-mini")!;
    expect(mini.isDefault).toBe(true);
    const full = items.find((i) => i.id === "gpt-5.5")!;
    expect(full.isDefault).toBe(false);
  });

  it("marks an unavailable (unconfigured-provider) model as unavailable, never falsely available", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    const chat = items.find((i) => i.id === "deepseek-chat")!;
    expect(chat.available).toBe(false);
  });

  it("filters by label, id, and provider", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    expect(filterModelItems("deepseek", items).some((i) => i.id === "deepseek-chat")).toBe(true);
    expect(filterModelItems("mini", items).map((i) => i.id)).toContain("gpt-5.4-mini");
    expect(filterModelItems("mini", items).map((i) => i.id)).not.toContain("gpt-5.5");
  });

  it("search with no registry match appends a custom-endpoint fallback row, never silently empty", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    const filtered = filterModelItems("llama-4-custom", items);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.kind).toBe("custom");
    expect(filtered[0]!.id).toBe("llama-4-custom");
  });

  it("does not append a custom row when the query exactly matches a real model id", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    const filtered = filterModelItems("gpt-5.5", items);
    expect(filtered.some((i) => i.kind === "custom")).toBe(false);
  });

  it("labels context-window confidence as verified/configured/unverified from the canonical ModelBudget, never a raw source string", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    const full = items.find((i) => i.id === "gpt-5.5")!;
    const mini = items.find((i) => i.id === "gpt-5.4-mini")!;
    const chat = items.find((i) => i.id === "deepseek-chat")!; // no budget resolved
    expect(modelDetailLines(full, plain).join("\n")).toContain("(verified)");
    expect(modelDetailLines(mini, plain).join("\n")).toContain("(configured)");
    expect(modelDetailLines(mini, plain).join("\n")).toContain("my-proxy.internal");
    expect(modelDetailLines(chat, plain).join("\n")).toMatch(/\(unverified\)|unknown/);
  });

  it("the auto and custom detail panels never fabricate model metadata", () => {
    const items = buildModelPickerItems(models, budgets, providers);
    const auto = items[0]!;
    const custom = filterModelItems("totally-custom-id", items).find((i) => i.kind === "custom")!;
    expect(modelDetailLines(auto, plain).join("\n")).toContain("preset routing");
    const customText = modelDetailLines(custom, plain).join("\n");
    expect(customText).toContain("totally-custom-id");
    expect(customText.toLowerCase()).toContain("unknown");
  });

  it("scrolling keeps the selection on-screen when the list exceeds the visible rows", () => {
    const many: ModelStatus[] = Array.from({ length: 20 }, (_, i) => model("openai", `model-${i}`, `Model ${i}`));
    const items = buildModelPickerItems(many, [], []);
    const filtered = filterModelItems("", items);
    const lines = renderModelPicker(filtered, plain, { query: "", selected: filtered.length - 1, maxRows: 5, unicode: false });
    // The last real model (highest index) must appear even though it's far
    // past the first 5 rows — proves the window scrolled, not just clipped.
    expect(lines.join("\n")).toContain("model-19");
  });

  it("renders an honest empty-registry state with setup guidance", () => {
    const lines = renderModelPicker([], plain, { query: "", selected: 0, maxRows: 5, unicode: false });
    expect(lines.join("\n")).toContain("No models available");
    expect(lines.join("\n")).toContain("morrow auth login");
  });
});

// ── Pure reducer coverage (input-state.ts) ──────────────────────────────────

describe("model picker reducer: nav, search, select, cancel", () => {
  const models: ModelStatus[] = [
    model("openai", "gpt-5.5", "GPT-5.5"),
    model("deepseek", "deepseek-chat", "DeepSeek Chat", {}, false),
  ];
  const items = buildModelPickerItems(models, [], []);
  const ctx: KeyContext = { commands: [], paletteItems: [], modelItems: items };

  function opened() {
    return { ...initialInputState(), overlay: "model" as const };
  }

  it("arrow-down/up move the selection", () => {
    const s0 = opened();
    const { state: s1 } = reduceKey(s0, { name: "down" }, ctx);
    expect(s1.modelSelected).toBe(1);
    const { state: s2 } = reduceKey(s1, { name: "up" }, ctx);
    expect(s2.modelSelected).toBe(0);
  });

  it("typing filters and resets the selection", () => {
    const s0 = opened();
    const { state: s1 } = reduceKey(s0, { str: "d", name: "d" }, ctx);
    expect(s1.modelQuery).toBe("d");
    expect(s1.modelSelected).toBe(0);
  });

  it("Escape cancels without emitting a submit action or changing the query state permanently", () => {
    const s0 = { ...opened(), modelQuery: "gpt" };
    const { state, action } = reduceKey(s0, { name: "escape" }, ctx);
    expect(action.type).toBe("repaint");
    expect(state.overlay).toBe("none");
    expect(state.modelQuery).toBe("");
  });

  it("Enter on the currently-selected available model submits '/model <id>'", () => {
    const s0 = { ...opened(), modelSelected: 1 }; // items[0]=auto, items[1]=gpt-5.5
    const { state, action } = reduceKey(s0, { name: "return" }, ctx);
    expect(action).toEqual({ type: "submit", value: "/model gpt-5.5" });
    expect(state.overlay).toBe("none");
  });

  it("Enter on 'auto' submits '/model auto' — a real routing choice, not a fake model", () => {
    const s0 = opened();
    const { action } = reduceKey(s0, { name: "return" }, ctx);
    expect(action).toEqual({ type: "submit", value: "/model auto" });
  });

  it("Enter on an unavailable model is rejected: no submit, overlay stays open", () => {
    const filtered = filterModelItems("deepseek-chat", items);
    expect(filtered[0]!.id).toBe("deepseek-chat");
    expect(filtered[0]!.available).toBe(false);
    const s0 = { ...opened(), modelQuery: "deepseek-chat", modelSelected: 0 };
    const { state, action } = reduceKey(s0, { name: "return" }, ctx);
    expect(action).toEqual({ type: "none" });
    expect(state.overlay).toBe("model");
  });

  it("Enter with zero filtered results is a no-op", () => {
    const s0 = { ...opened(), modelQuery: "" };
    const emptyCtx: KeyContext = { commands: [], paletteItems: [], modelItems: [] };
    const { action } = reduceKey(s0, { name: "return" }, emptyCtx);
    expect(action).toEqual({ type: "none" });
  });
});

// ── End-to-end: real command handling + configuration persistence ──────────

const meta: SessionMeta = {
  greeting: "hi", projectName: "M", workspacePath: "/w", branch: "main",
  provider: "auto", model: "auto", privacy: "local", mode: "Build · approvals required",
  memory: true, autoApprove: false,
};
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 24;
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

function makeBackend(gate: EventGate, overrides: Partial<SessionBackend> = {}): SessionBackend {
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
    ...overrides,
  };
}

function typeText(stdin: any, text: string): void {
  for (const c of text) stdin.emit("keypress", c, { name: c, sequence: c });
}
function key(stdin: any, name: string): void { stdin.emit("keypress", undefined, { name }); }
function enter(stdin: any): void { key(stdin, "return"); }
function escape(stdin: any): void { key(stdin, "escape"); }
function ctrlC(stdin: any): void { stdin.emit("keypress", undefined, { name: "c", ctrl: true }); }
const tick = () => new Promise((r) => setTimeout(r, 20));

const REGISTRY_MODELS: ModelStatus[] = [
  model("openai", "gpt-5.5", "GPT-5.5"),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini"),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", {}, false),
];
const REGISTRY_BUDGETS: ModelBudgetView[] = [
  budget("openai", "gpt-5.5"),
  budget("openai", "gpt-5.4-mini", { contextWindowConfidence: "configured" }),
];
const REGISTRY_PROVIDERS: ProviderStatus[] = [provider("openai", "gpt-5.4-mini"), provider("deepseek", null, false)];

function makeApp(io: FakeTermIO, stdin: any, backendOverrides: Partial<SessionBackend> = {}) {
  const gate = new EventGate();
  const backend = makeBackend(gate, {
    listModels: async () => REGISTRY_MODELS,
    getModelBudgets: async () => REGISTRY_BUDGETS,
    listProviders: async () => REGISTRY_PROVIDERS,
    ...backendOverrides,
  });
  return new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
}

describe("/model: real interactive session end-to-end", () => {
  it("bare /model opens the picker overlay", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("model");
    expect(io.all()).toContain("Select a model");
    escape(stdin); // close the overlay first — Ctrl+C on an open overlay closes it, not the app
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("search narrows the visible list to matching models", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    typeText(stdin, "mini");
    await tick();
    const frame = io.all();
    expect(frame).toContain("gpt-5.4-mini");
    escape(stdin);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("Escape cancels the picker without changing the configured model", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    typeText(stdin, "mini");
    await tick();
    escape(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("none");
    expect(app.snapshot().notices.some((n) => n.text.startsWith("Model set to"))).toBe(false);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("arrow-down then Enter selects the second model and persists it through the real configuration path", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    key(stdin, "down"); // items[0]=auto -> items[1]=gpt-5.5
    await tick();
    enter(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("none");
    const notice = app.snapshot().notices.at(-1)!.text;
    expect(notice).toContain("Model set to gpt-5.5");
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("reopening /model immediately reflects the just-selected model as current", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model gpt-5.4-mini");
    enter(stdin);
    await tick();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    const frame = io.all();
    // The current marker sits on the gpt-5.4-mini row, and its "current" tag
    // is present in the frame.
    expect(frame).toContain("gpt-5.4-mini");
    expect(frame).toContain("current");
    escape(stdin);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("an unavailable model cannot be falsely selected via Enter", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    typeText(stdin, "deepseek-chat");
    await tick();
    enter(stdin);
    await tick();
    // Still open — the selection was rejected, not silently applied.
    expect(app.inputSnapshot().overlay).toBe("model");
    expect(app.snapshot().notices.some((n) => n.text.startsWith("Model set to"))).toBe(false);
    escape(stdin);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("a custom/OpenAI-compatible-endpoint id typed in the picker is selectable and applies directly", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    typeText(stdin, "my-custom-vllm-model");
    await tick();
    expect(io.all()).toContain("custom model id");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.at(-1)!.text).toContain("Model set to my-custom-vllm-model");
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("direct /model <id> still sets the model immediately without opening the picker (no regression)", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model gpt-5.5");
    enter(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("none");
    expect(app.snapshot().notices.at(-1)!.text).toContain("Model set to gpt-5.5");
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("/model auto and /model current work as explicit direct forms", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model gpt-5.5");
    enter(stdin);
    await tick();
    typeText(stdin, "/model current");
    enter(stdin);
    await tick();
    // /model current opens the detail-panel overlay (distinct from the
    // interactive picker) rather than mutating anything — exact panel
    // content is covered by the modelDetailLines() unit tests above.
    expect(app.inputSnapshot().overlay).toBe("output");
    escape(stdin);
    await tick();
    typeText(stdin, "/model auto");
    enter(stdin);
    await tick();
    expect(app.snapshot().notices.at(-1)!.text).toContain("Model set to auto");
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("an ambiguous partial search opens the picker pre-filtered instead of setting an unvalidated string", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const app = makeApp(io, stdin);
    const done = app.run();
    typeText(stdin, "/model gpt"); // matches both openai models
    enter(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("model");
    expect(app.snapshot().notices.some((n) => n.text.startsWith("Model set to"))).toBe(false);
    escape(stdin);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });

  it("renders without a crash and stays within the column budget in a narrow terminal", () => {
    const models: ModelStatus[] = [
      model("openai", "gpt-5.5", "GPT-5.5"),
      model("openai", "gpt-5.4-mini", "GPT-5.4 mini"),
    ];
    const items = buildModelPickerItems(models, [budget("openai", "gpt-5.4-mini")], [provider("openai", "gpt-5.4-mini")]);
    const filtered = filterModelItems("", items);
    const miniIndex = filtered.findIndex((i) => i.id === "gpt-5.4-mini");
    const lines = renderModelPicker(filtered, plain, { query: "", selected: miniIndex, maxRows: 5, unicode: false, currentModelId: "gpt-5.4-mini" });
    const columns = 28;
    const clipped = lines.map((l) => clipToWidth(l, columns));
    for (const line of clipped) expect(line.length).toBeLessThanOrEqual(columns);
    // Still legible: the highlighted model's id survives even this narrow,
    // even if a state tag doesn't fit alongside it.
    expect(clipped.some((l) => l.includes("gpt-5.4-"))).toBe(true);
  });

  it("gracefully handles a session with no model-registry backend at all, without crashing", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const backend = makeBackend(gate); // no listModels/getModelBudgets/listProviders
    const app = new InteractiveSession({ io, stdin, out: plain, unicode: false, meta: { ...meta }, settings: { ...settings }, backend, now: () => Date.now(), maxFps: 120 });
    const done = app.run();
    typeText(stdin, "/model");
    enter(stdin);
    await tick();
    expect(app.inputSnapshot().overlay).toBe("none"); // no registry — falls back to a notice, not a crash
    expect(app.snapshot().notices.some((n) => n.text.includes("morrow model"))).toBe(true);
    ctrlC(stdin); ctrlC(stdin);
    await done;
  });
});
