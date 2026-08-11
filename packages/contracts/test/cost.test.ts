import { describe, expect, it } from "vitest";
import {
  CostAccuracySchema,
  CostLineSchema,
  MoneyAmountSchema,
  PricingSnapshotSchema,
  TaskCostSummarySchema,
  type CostLine,
  type PricingSnapshot,
} from "../src/index.js";
import { calculateUsageCostMicros } from "../src/cost.js";

const authoritativePricing = (overrides: Partial<PricingSnapshot> = {}): PricingSnapshot => ({
  inputMicrosPerMillion: 140_000,
  outputMicrosPerMillion: 280_000,
  cachedInputMicrosPerMillion: null,
  source: "authoritative",
  metadataVersion: "catalog-v1",
  fetchedAt: "2026-08-11T00:00:00.000Z",
  ...overrides,
});

function costLine(overrides: Partial<CostLine> = {}): CostLine {
  return CostLineSchema.parse({
    id: "line-1",
    taskId: "task-1",
    requestId: "request-1",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    amount: { currency: "USD", micros: 10_000 },
    accuracy: "exact_usage_pricing",
    pricing: authoritativePricing(),
    recordedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  });
}

describe("fixed-point cost contracts", () => {
  it("calculates one million input and 500,000 output tokens as integer micro-USD", () => {
    const result = calculateUsageCostMicros(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      authoritativePricing(),
    );

    expect(result).toEqual({
      amount: { currency: "USD", micros: 280_000 },
      accuracy: "exact_usage_pricing",
    });
    expect(Number.isInteger(result.amount?.micros)).toBe(true);
  });

  it("preserves exact zero for a local model with zero rates", () => {
    const result = calculateUsageCostMicros(
      { inputTokens: 1_000, outputTokens: 500 },
      authoritativePricing({ inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0 }),
    );

    expect(result).toEqual({
      amount: { currency: "USD", micros: 0 },
      accuracy: "exact_usage_pricing",
    });
  });

  it("returns unknown with no amount when provider usage is missing", () => {
    expect(calculateUsageCostMicros(null, authoritativePricing())).toEqual({
      amount: null,
      accuracy: "unknown",
    });
    expect(calculateUsageCostMicros({ inputTokens: null, outputTokens: 1 }, authoritativePricing())).toEqual({
      amount: null,
      accuracy: "unknown",
    });
  });

  it("returns unknown with no amount when authoritative pricing is missing", () => {
    expect(calculateUsageCostMicros({ inputTokens: 1, outputTokens: 1 }, null)).toEqual({
      amount: null,
      accuracy: "unknown",
    });
    expect(calculateUsageCostMicros(
      { inputTokens: 1, outputTokens: 1 },
      authoritativePricing({ source: "provider-reported" }),
    )).toEqual({ amount: null, accuracy: "unknown" });
  });

  it("marks a cache-discounted estimate without a provider cache breakdown as estimated", () => {
    const result = calculateUsageCostMicros(
      { inputTokens: 1_000_000, cachedInputTokens: null, outputTokens: 0 },
      authoritativePricing({ cachedInputMicrosPerMillion: 14_000 }),
    );

    expect(result.accuracy).toBe("estimated");
    expect(result.accuracy).not.toBe("exact_usage_pricing");
    expect(result.amount).toEqual({ currency: "USD", micros: 140_000 });
  });

  it("sums equal cost lines deterministically while preserving request identity", () => {
    const first = costLine({ id: "line-1", requestId: "request-1" });
    const second = costLine({ id: "line-2", requestId: "request-2" });
    const summary = TaskCostSummarySchema.parse({
      taskId: "task-1",
      total: { currency: "USD", micros: first.amount!.micros + second.amount!.micros },
      accuracy: "exact_usage_pricing",
      requestCount: 2,
      totalInputTokens: 2_000_000,
      knownFreshInputTokens: 2_000_000,
      knownCachedInputTokens: 0,
      outputTokens: 0,
      cacheBreakdownComplete: true,
      lines: [first, second],
    });

    expect(summary.total).toEqual({ currency: "USD", micros: 20_000 });
    expect(summary.lines.map((line) => line.requestId)).toEqual(["request-1", "request-2"]);
  });

  it("keeps known lines visible but rejects a partial total when one line is unknown", () => {
    const known = costLine();
    const unknown = costLine({
      id: "line-unknown",
      requestId: "request-unknown",
      amount: null,
      accuracy: "unknown",
      pricing: null,
    });
    const base = {
      taskId: "task-1",
      requestCount: 2,
      totalInputTokens: 2_000_000,
      knownFreshInputTokens: 1_000_000,
      knownCachedInputTokens: 0,
      outputTokens: 0,
      cacheBreakdownComplete: true,
      lines: [known, unknown],
    };

    expect(() => TaskCostSummarySchema.parse({
      ...base,
      total: { currency: "USD", micros: known.amount!.micros },
      accuracy: "estimated",
    })).toThrow(/total.*null|accuracy.*unknown/i);

    const summary = TaskCostSummarySchema.parse({ ...base, total: null, accuracy: "unknown" });
    expect(summary.lines[0]?.amount).toEqual({ currency: "USD", micros: 10_000 });
    expect(summary.lines[1]?.amount).toBeNull();
  });

  it("supports provider-billed as a contract value without allowing the current calculator to emit it", () => {
    expect(CostAccuracySchema.parse("provider_billed")).toBe("provider_billed");
    expect(MoneyAmountSchema.parse({ currency: "USD", micros: 1 })).toEqual({ currency: "USD", micros: 1 });
    expect(PricingSnapshotSchema.parse(authoritativePricing()).source).toBe("authoritative");
    expect(calculateUsageCostMicros({ inputTokens: 1, outputTokens: 1 }, authoritativePricing()).accuracy)
      .not.toBe("provider_billed");
  });

  it("rejects a cached-token subset larger than total input", () => {
    expect(() => calculateUsageCostMicros(
      { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 },
      authoritativePricing({ cachedInputMicrosPerMillion: 1 }),
    )).toThrow(/cached.*input/i);
  });

  it("rejects a pricing rate that cannot be represented as a safe integer micro-rate", () => {
    expect(() => calculateUsageCostMicros(
      { inputTokens: 1, outputTokens: 0 },
      authoritativePricing({ inputMicrosPerMillion: Number.MAX_SAFE_INTEGER + 1 }),
    )).toThrow(/safe.*micro/i);
  });
});
