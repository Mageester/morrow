import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/terminal/state.js";
import type { TerminalEvent } from "../src/terminal/events.js";

function fold(events: TerminalEvent[]) {
  return events.reduce((state, event) => reduce(state, event), initialState());
}

describe("terminal usage state", () => {
  it("accumulates provider-reported usage across multiple calls", () => {
    const state = fold([
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 20 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5, cachedInputTokens: 10 },
    ]);
    expect(state.usage).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      inputTokens: 150,
      outputTokens: 25,
      totalTokens: 175,
      cachedInputTokens: 10,
      calls: 2,
    });
  });

  it("keeps usage unknown when the provider does not report it", () => {
    const state = fold([{ type: "assistant.turn_start", turnId: "t1" }, { type: "assistant.delta", turnId: "t1", text: "hello" }]);
    expect(state.usage).toBeUndefined();
  });

  it("keeps cumulative cached tokens null (not 0) when no response has ever reported them", () => {
    const state = fold([
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 20 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5 },
    ]);
    expect(state.usage?.cachedInputTokens).toBeNull();
  });

  it("preserves a known cumulative cached total across a later response that doesn't report one", () => {
    const state = fold([
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5 },
    ]);
    // The second response's own usage never reported caching, but that must
    // not erase or zero out the total already established by the first.
    expect(state.usage?.cachedInputTokens).toBe(40);
    expect(state.activeUsage?.cachedInputTokens).toBeNull();
  });

  it("separates the current (active) response's usage from the cumulative session total", () => {
    const state = fold([
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 20 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5 },
    ]);
    // A UI reading activeUsage must see only the latest response's size, not
    // the running session total — these must never be conflated.
    expect(state.activeUsage).toMatchObject({ inputTokens: 50, outputTokens: 5, totalTokens: 55 });
    expect(state.usage).toMatchObject({ inputTokens: 150, outputTokens: 25, totalTokens: 175 });
  });

  it("accumulates authoritative estimated cost when every usage event supplies it", () => {
    const state = fold([
      { type: "usage.reported", provider: "ollama", model: "llama3.1", inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0 },
      { type: "usage.reported", provider: "ollama", model: "llama3.1", inputTokens: 50, outputTokens: 5, estimatedCostUsd: 0 },
    ]);
    expect(state.usage?.estimatedCostUsd).toBe(0);
  });

  it("marks accumulated cost unknown when any usage event lacks authoritative pricing", () => {
    const state = fold([
      { type: "usage.reported", provider: "ollama", model: "llama3.1", inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5 },
    ]);
    expect(state.usage?.estimatedCostUsd).toBeNull();
  });

  it("tracks provider/model changes during a session", () => {
    const state = fold([
      { type: "usage.reported", provider: "openai", model: "gpt-5.4-mini", inputTokens: 10, outputTokens: 2 },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 20, outputTokens: 3 },
    ]);
    expect(state.usage?.provider).toBe("deepseek");
    expect(state.usage?.model).toBe("deepseek-v4-flash");
    expect(state.usage?.providerChanges).toEqual(["openai/gpt-5.4-mini", "deepseek/deepseek-v4-flash"]);
  });

  it("calculates context percentage only when the context limit is known", () => {
    const known = fold([
      {
        type: "context.usage",
        usage: {
          usedTokens: 21_000,
          maxTokens: 128_000,
          contextLimitTokens: 128_000,
          contextWindowSource: "known-model",
          method: "exact",
          compactedGroups: 0,
          removedGroups: 0,
        },
      },
    ]);
    expect(known.contextUsage?.percent).toBe(16);

    const unknown = fold([
      {
        type: "context.usage",
        usage: {
          usedTokens: 21_000,
          maxTokens: 0,
          contextLimitTokens: null,
          contextWindowSource: "fallback",
          method: "estimate",
          compactedGroups: 0,
          removedGroups: 0,
        },
      },
    ]);
    expect(unknown.contextUsage?.percent).toBeNull();
  });
});
