import { describe, expect, it } from "vitest";
import {
  resolveRequestUsage,
  accumulateUsage,
  EMPTY_CUMULATIVE_USAGE,
  type CumulativeUsage,
} from "../src/routing/usage-snapshot.js";
import { resolveModelMetadata } from "../src/routing/models.js";

describe("canonical usage snapshot (token + cost accounting truth)", () => {
  it("separates fresh input from cached input and from output", () => {
    const usage = resolveRequestUsage({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      usage: { promptTokens: 500, completionTokens: 120, cachedPromptTokens: 200 },
    });
    expect(usage.freshInputTokens).toBe(300);
    expect(usage.cachedInputTokens).toBe(200);
    expect(usage.outputTokens).toBe(120);
    expect(usage.totalTokens).toBe(620); // 300 + 200 + 120 — all three known
  });

  it("represents an unreported cached-token count as unavailable, never as zero", () => {
    const usage = resolveRequestUsage({
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      usage: { promptTokens: 500, completionTokens: 120 },
    });
    expect(usage.cachedInputTokens).toBeNull();
    expect(usage.freshInputTokens).toBe(500);
    // totalTokens is still knowable here because "no cache" and "0 cache" are
    // the same number when computing a wire total (fresh + 0 + output);
    // what must never happen is a *cumulative cached total* being invented.
  });

  it("represents a missing provider usage report as fully unavailable, not zero", () => {
    const usage = resolveRequestUsage({ providerId: "mock", modelId: "mock-model", usage: null });
    expect(usage.freshInputTokens).toBeNull();
    expect(usage.cachedInputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
    expect(usage.tokenSource).toBe("unavailable");
    expect(usage.tokenConfidence).toBe("unavailable");
    expect(usage.costSource).toBe("unavailable");
  });

  it("distinguishes provider-metered cost (never claimed today) from morrow-estimated cost", () => {
    const metadata = resolveModelMetadata("anthropic", "claude-3-5-haiku-20241022");
    const usage = resolveRequestUsage({
      providerId: "anthropic",
      modelId: "claude-3-5-haiku-20241022",
      usage: { promptTokens: 1000, completionTokens: 200 },
      metadata,
    });
    // No pricing is marked "authoritative" for this built-in model, so cost
    // must be honestly unavailable rather than a fabricated estimate.
    expect(usage.costSource).toBe("unavailable");
    expect(usage.costUsd).toBeNull();
    // Morrow never ingests real provider billing today — "provider-metered"
    // must never appear as an actual costSource value from this resolver.
    const model = resolveModelMetadata("ollama", "llama3.1");
    const localUsage = resolveRequestUsage({
      providerId: "ollama",
      modelId: "llama3.1",
      usage: { promptTokens: 1000, completionTokens: 200 },
      metadata: model,
    });
    expect(localUsage.costSource).not.toBe("provider-metered");
  });

  it("folds cumulative totals exactly once per response and never re-derives them by re-summing", () => {
    const first = resolveRequestUsage({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      usage: { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 400 },
    });
    const second = resolveRequestUsage({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      usage: { promptTokens: 500, completionTokens: 50 }, // no cached breakdown this time
    });

    let cumulative: CumulativeUsage = EMPTY_CUMULATIVE_USAGE;
    cumulative = accumulateUsage(cumulative, first);
    expect(cumulative).toMatchObject({ responseCount: 1, freshInputTokens: 600, cachedInputTokens: 400, outputTokens: 100 });

    cumulative = accumulateUsage(cumulative, second);
    expect(cumulative.responseCount).toBe(2);
    expect(cumulative.freshInputTokens).toBe(1100); // 600 + 500
    expect(cumulative.cachedInputTokens).toBe(400); // carried forward, not reset
    expect(cumulative.outputTokens).toBe(150); // 100 + 50

    // The single most recent response's own size must stay distinct from
    // the cumulative total — a UI must never present the cumulative task
    // total as if it were the size of one provider request.
    expect(second.freshInputTokens).not.toBe(cumulative.freshInputTokens);
  });

  it("keeps cumulative cached tokens null until any response ever reports one", () => {
    const noCache = resolveRequestUsage({ providerId: "p", modelId: "m", usage: { promptTokens: 10, completionTokens: 1 } });
    const cumulative = accumulateUsage(EMPTY_CUMULATIVE_USAGE, noCache);
    expect(cumulative.cachedInputTokens).toBeNull();
  });

  it("folds cumulative cost only from known values and leaves it null until one is known", () => {
    const unknownCost = resolveRequestUsage({ providerId: "custom", modelId: "unregistered-model", usage: { promptTokens: 10, completionTokens: 1 } });
    expect(unknownCost.costUsd).toBeNull();
    const cumulative = accumulateUsage(EMPTY_CUMULATIVE_USAGE, unknownCost);
    expect(cumulative.totalCostUsd).toBeNull();
  });
});
