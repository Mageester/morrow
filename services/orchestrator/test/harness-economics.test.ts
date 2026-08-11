import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_V4_PRO_PRICING,
  estimateBenchmarkCost,
  parseBenchmarkRecords,
  renderBenchmarkSvg,
  summarizeBenchmarkRecords,
} from "../../../benchmarks/harness-economics/metrics.js";

describe("personal harness economics benchmark", () => {
  it("estimates cache-aware cost from provider token pricing", () => {
    const result = estimateBenchmarkCost({
      harness: "Morrow",
      model: "deepseek-v4-pro",
      passed: true,
      durationMs: 12_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 900_000,
      outputTokens: 100_000,
      pricing: DEEPSEEK_V4_PRO_PRICING,
    });

    expect(result).toEqual({ amountUsd: 0.1337625, source: "estimated" });
  });

  it("summarizes pass rate and medians without inventing missing costs", () => {
    const summaries = summarizeBenchmarkRecords([
      { harness: "Morrow", passed: true, durationMs: 1000, measuredCostUsd: 0.01 },
      { harness: "Morrow", passed: false, durationMs: 3000, measuredCostUsd: null },
      { harness: "Other", passed: true, durationMs: 2000 },
    ]);

    expect(summaries).toEqual([
      {
        harness: "Morrow",
        sampleSize: 2,
        passRate: 0.5,
        medianCostUsd: 0.01,
        medianTimeMs: 2000,
        costSource: "measured",
        costSamples: 1,
        medianProviderCalls: null,
        medianToolCalls: null,
        medianDuplicateObservations: null,
        medianContextCompactions: null,
        medianRecoveryAttempts: null,
        medianInterventions: null,
      },
      {
        harness: "Other",
        sampleSize: 1,
        passRate: 1,
        medianCostUsd: null,
        medianTimeMs: 2000,
        costSource: "unavailable",
        costSamples: 0,
        medianProviderCalls: null,
        medianToolCalls: null,
        medianDuplicateObservations: null,
        medianContextCompactions: null,
        medianRecoveryAttempts: null,
        medianInterventions: null,
      },
    ]);
  });

  it("summarizes optional provider and harness efficiency counters without inventing zeros", () => {
    const summaries = summarizeBenchmarkRecords([
      {
        harness: "Morrow",
        passed: true,
        durationMs: 1000,
        providerCalls: 4,
        toolCalls: 6,
        duplicateObservations: 1,
        contextCompactions: 0,
        recoveryAttempts: 0,
        interventions: 1,
      },
      {
        harness: "Morrow",
        passed: true,
        durationMs: 1200,
        providerCalls: 6,
        toolCalls: 8,
        duplicateObservations: 3,
        contextCompactions: 2,
        recoveryAttempts: 1,
        interventions: 0,
      },
      { harness: "Other", passed: true, durationMs: 900 },
    ]);

    expect(summaries[0]).toMatchObject({
      medianProviderCalls: 5,
      medianToolCalls: 7,
      medianDuplicateObservations: 2,
      medianContextCompactions: 1,
      medianRecoveryAttempts: 0.5,
      medianInterventions: 0.5,
    });
    expect(summaries[1]).toMatchObject({
      medianProviderCalls: null,
      medianToolCalls: null,
      medianDuplicateObservations: null,
      medianContextCompactions: null,
      medianRecoveryAttempts: null,
      medianInterventions: null,
    });
  });

  it("parses a records envelope and renders an inspectable three-panel chart", () => {
    const records = parseBenchmarkRecords({
      records: [
        {
          harness: "Morrow",
          model: "deepseek-v4-flash",
          scenario: "long-context",
          benchmarkRun: "corrected-fixture-2026-08-11",
          evidenceClass: "deterministic-local",
          outcome: "success",
          reasoningMode: "off",
          passed: true,
          durationMs: 1500,
          timeToFirstTokenMs: 4.5,
          providerCompletionMs: 9.5,
          measuredCostUsd: 0.02,
          reasoningTokens: null,
          requestInputTokens: [120, 180],
          contextTokenSamples: [500, 180],
          contextGrowthTokens: 320,
          harnessOverheadTokens: 100,
          toolSchemaTokens: 80,
          protocolOverheadTokens: 15,
          providerContinuationTokens: 5,
          toolFailures: 1,
          fallbackEvents: 0,
        },
        { harness: "Other", passed: false, durationMs: 2500, measuredCostUsd: 0.04 },
      ],
    });

    expect(records[0]).toMatchObject({
      benchmarkRun: "corrected-fixture-2026-08-11",
      timeToFirstTokenMs: 4.5,
      providerCompletionMs: 9.5,
      requestInputTokens: [120, 180],
      contextTokenSamples: [500, 180],
      reasoningTokens: null,
      toolSchemaTokens: 80,
      protocolOverheadTokens: 15,
      providerContinuationTokens: 5,
    });
    const svg = renderBenchmarkSvg(summarizeBenchmarkRecords(records), { title: "DeepSeek V4 Flash" });

    expect(svg).toContain("<svg");
    expect(svg).toContain("Pass rate");
    expect(svg).toContain("Median cost per task");
    expect(svg).toContain("Median time per task");
    expect(svg).toContain("Morrow");
    expect(svg).toContain("$0.020");
  });

  it("rejects records that cannot produce trustworthy comparisons", () => {
    expect(() => parseBenchmarkRecords([{ harness: "Morrow", passed: true, durationMs: -1 }])).toThrow(
      "durationMs must be a non-negative number",
    );
    expect(() => parseBenchmarkRecords([{ harness: "Morrow", passed: true, durationMs: 1, providerCalls: -1 }])).toThrow(
      "providerCalls must be a non-negative integer",
    );
  });
});
