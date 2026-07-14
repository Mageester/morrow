import { describe, expect, it } from "vitest";
import {
  resolveRequestUsage,
  accumulateUsage,
  EMPTY_CUMULATIVE_USAGE,
  type CumulativeUsage,
} from "../src/routing/usage-snapshot.js";
import { resolveModelMetadata } from "../src/routing/models.js";

describe("canonical usage snapshot (token + cost accounting truth)", () => {
  it("computes an exact fresh/cached split only when the provider reports the cache breakdown", () => {
    const usage = resolveRequestUsage({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      usage: { promptTokens: 500, completionTokens: 120, cachedPromptTokens: 200 },
    });
    expect(usage.totalInputTokens).toBe(500);
    expect(usage.freshInputTokens).toBe(300);
    expect(usage.cachedInputTokens).toBe(200);
    expect(usage.outputTokens).toBe(120);
    expect(usage.totalTokens).toBe(620);
    expect(usage.cacheBreakdownStatus).toBe("reported");
  });

  it("keeps total input known but leaves fresh AND cached null when the cache breakdown is absent — never treats total as all-fresh", () => {
    const usage = resolveRequestUsage({
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      usage: { promptTokens: 500, completionTokens: 120 },
    });
    expect(usage.totalInputTokens).toBe(500);
    expect(usage.freshInputTokens).toBeNull();
    expect(usage.cachedInputTokens).toBeNull();
    expect(usage.cacheBreakdownStatus).toBe("unavailable");
    // The wire total is still knowable without the cache split.
    expect(usage.outputTokens).toBe(120);
    expect(usage.totalTokens).toBe(620);
    // tokenConfidence describes total/output truth, not the cache split —
    // it must stay "exact" here without implying the split is known.
    expect(usage.tokenConfidence).toBe("exact");
  });

  it("represents a missing provider usage report as fully unavailable, not zero", () => {
    const usage = resolveRequestUsage({ providerId: "mock", modelId: "mock-model", usage: null });
    expect(usage.totalInputTokens).toBeNull();
    expect(usage.freshInputTokens).toBeNull();
    expect(usage.cachedInputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
    expect(usage.cacheBreakdownStatus).toBe("unavailable");
    expect(usage.tokenSource).toBe("unavailable");
    expect(usage.tokenConfidence).toBe("unavailable");
    expect(usage.costSource).toBe("unavailable");
  });

  it("distinguishes provider-metered cost (never claimed today) from morrow-estimated cost, and never claims a cache-adjusted estimate without a known breakdown", () => {
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
    expect(usage.cacheBreakdownStatus).toBe("unavailable");
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
    expect(cumulative).toMatchObject({
      responseCount: 1,
      totalInputTokens: 1000,
      knownFreshInputTokens: 600,
      knownCachedInputTokens: 400,
      outputTokens: 100,
      cacheBreakdownComplete: true,
    });

    cumulative = accumulateUsage(cumulative, second);
    expect(cumulative.responseCount).toBe(2);
    // Total input is always a complete, exact sum regardless of breakdown status.
    expect(cumulative.totalInputTokens).toBe(1500); // 1000 + 500
    expect(cumulative.outputTokens).toBe(150); // 100 + 50
    // The second response never reported a cache breakdown, so the fresh/
    // cached split is no longer complete — the known subtotals are frozen
    // at the first response's contribution, not a false "1100/400" split.
    expect(cumulative.cacheBreakdownComplete).toBe(false);
    expect(cumulative.knownFreshInputTokens).toBe(600); // only from response 1
    expect(cumulative.knownCachedInputTokens).toBe(400); // only from response 1

    // The single most recent response's own size must stay distinct from
    // the cumulative total — a UI must never present the cumulative task
    // total as if it were the size of one provider request.
    expect(second.totalInputTokens).not.toBe(cumulative.totalInputTokens);
  });

  it("shows an exact cumulative fresh/cached split only when every folded response reported one", () => {
    const first = resolveRequestUsage({ providerId: "p", modelId: "m", usage: { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 20 } });
    const second = resolveRequestUsage({ providerId: "p", modelId: "m", usage: { promptTokens: 200, completionTokens: 20, cachedPromptTokens: 50 } });
    let cumulative: CumulativeUsage = EMPTY_CUMULATIVE_USAGE;
    cumulative = accumulateUsage(cumulative, first);
    cumulative = accumulateUsage(cumulative, second);
    expect(cumulative.cacheBreakdownComplete).toBe(true);
    expect(cumulative.knownFreshInputTokens).toBe(80 + 150); // (100-20) + (200-50)
    expect(cumulative.knownCachedInputTokens).toBe(70); // 20 + 50
    expect(cumulative.totalInputTokens).toBe(300);
  });

  it("keeps cumulative known-cached tokens at 0 (not fabricated) until any response ever reports one, and total input still accrues", () => {
    const noCache = resolveRequestUsage({ providerId: "p", modelId: "m", usage: { promptTokens: 10, completionTokens: 1 } });
    const cumulative = accumulateUsage(EMPTY_CUMULATIVE_USAGE, noCache);
    expect(cumulative.knownCachedInputTokens).toBe(0);
    expect(cumulative.cacheBreakdownComplete).toBe(false);
    expect(cumulative.totalInputTokens).toBe(10);
  });

  it("folds cumulative cost only from known values and leaves it null until one is known", () => {
    const unknownCost = resolveRequestUsage({ providerId: "custom", modelId: "unregistered-model", usage: { promptTokens: 10, completionTokens: 1 } });
    expect(unknownCost.costUsd).toBeNull();
    const cumulative = accumulateUsage(EMPTY_CUMULATIVE_USAGE, unknownCost);
    expect(cumulative.totalCostUsd).toBeNull();
  });
});
