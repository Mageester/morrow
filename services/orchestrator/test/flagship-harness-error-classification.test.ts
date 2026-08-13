import { describe, expect, it } from "vitest";
import { evaluateFlagshipGate } from "../src/acceptance/flagship-gate.js";
import type { FlagshipBuildRun, FlagshipFailureReason } from "../src/acceptance/flagship-build.js";
import { isPreGenerationHarnessFailure, projectFlagshipEfficiency } from "../src/acceptance/flagship-runner.js";

/**
 * Reproduced live on 2026-08-03: a DeepSeek account with no balance returned
 * HTTP 402 on every request. The provider refused before generating, so no
 * `app.mjs` existed, so each run was recorded as `artifact_missing` — scored as
 * though the model had failed to build the app. Ten such runs then filled the
 * provider's entire 10-run window and pinned it at 0/10, which a later topped-up
 * account could not clear until ten fresh runs displaced them.
 *
 * Two separate defects: misclassification, and environment failures poisoning
 * the scoring window. These pin both, and pin that the exclusion cannot be used
 * to launder a real model failure.
 */

const base: FlagshipBuildRun = {
  scenarioId: "flagship-build-v1",
  mode: "real",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  passed: false,
  failureReason: null,
  failureDetail: null,
  taskStatus: "failed",
  toolCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  artifactSha256: null,
  wallClockMs: 1000,
} as unknown as FlagshipBuildRun;

function run(overrides: Partial<FlagshipBuildRun>): FlagshipBuildRun {
  return { ...base, ...overrides } as FlagshipBuildRun;
}

function runs(count: number, overrides: Partial<FlagshipBuildRun>): FlagshipBuildRun[] {
  return Array.from({ length: count }, () => run(overrides));
}

describe("environment failures are not evidence about the model", () => {
  it("projects provider and harness-efficiency counters from authoritative events", () => {
    expect(projectFlagshipEfficiency([
      { type: "provider.usage", payload: { cachedInputTokens: 12 } },
      { type: "provider.usage", payload: {} },
      { type: "workspace.inspected", payload: { duplicate: true } },
      { type: "context.compaction_completed", payload: {} },
      { type: "provider_recovery_required", payload: {} },
      { type: "approval.requested", payload: {} },
    ])).toEqual({
      providerCalls: 2,
      cachedPromptTokens: 12,
      duplicateObservations: 1,
      contextCompactions: 1,
      recoveryAttempts: 1,
      interventions: 1,
    });

    expect(projectFlagshipEfficiency([{ type: "provider.usage", payload: {} }]).cachedPromptTokens).toBeNull();
    expect(projectFlagshipEfficiency([
      { type: "provider.request_started", payload: { provider: "primary" } },
      { type: "provider.request_started", payload: { provider: "secondary" } },
      { type: "provider.usage", payload: {} },
    ]).providerCalls).toBe(2);
    expect(projectFlagshipEfficiency([
      { type: "provider.fallback", payload: { recoveryAttempt: 1 } },
    ]).recoveryAttempts).toBe(1);
  });

  it("classifies only a failed task with zero tool calls and zero completion tokens as pre-generation", () => {
    expect(isPreGenerationHarnessFailure("failed", 0, 0)).toBe(true);
    expect(isPreGenerationHarnessFailure("failed", 1, 0)).toBe(false);
    expect(isPreGenerationHarnessFailure("failed", 0, 1)).toBe(false);
    expect(isPreGenerationHarnessFailure("completed", 0, 0)).toBe(false);
  });

  it("does not score harness errors against a provider", () => {
    const gate = evaluateFlagshipGate(runs(10, { passed: false, failureReason: "harness_error" }), { scenarioId: "flagship-build-v1" });
    expect(gate.passed).toBe(false);
    // The provider has no scorable runs at all, rather than a 0/10 record.
    expect(gate.providers).toEqual([]);
    expect(gate.excluded.harnessErrorRuns).toBe(10);
  });

  it("says plainly that nothing scorable was recorded", () => {
    const gate = evaluateFlagshipGate(runs(10, { passed: false, failureReason: "harness_error" }), { scenarioId: "flagship-build-v1" });
    expect(gate.summary).toContain("no real-provider runs recorded that are scorable");
    expect(gate.summary).toContain("10 harness/environment failure(s)");
  });

  it("lets a topped-up account qualify without waiting out the poisoned window", () => {
    const log = [
      ...runs(10, { passed: false, failureReason: "harness_error" }),
      ...runs(10, { passed: true, failureReason: null }),
      ...runs(10, { passed: true, failureReason: null, providerId: "opencode-zen" }),
    ];
    const gate = evaluateFlagshipGate(log, { scenarioId: "flagship-build-v1" });
    expect(gate.passed).toBe(true);
    expect(gate.providers.find((p) => p.providerId === "deepseek")).toMatchObject({ runs: 10, passes: 10 });
  });

  it("still scores every failure the model is responsible for", () => {
    const realFailures: FlagshipFailureReason[] = [
      "artifact_missing",
      "artifact_does_not_run",
      "contract_violated",
      "task_not_completed",
    ];
    for (const failureReason of realFailures) {
      const gate = evaluateFlagshipGate(runs(10, { passed: false, failureReason }), { scenarioId: "flagship-build-v1" });
      expect(gate.passed).toBe(false);
      expect(gate.providers[0]).toMatchObject({ providerId: "deepseek", runs: 10, passes: 0 });
      expect(gate.excluded.harnessErrorRuns).toBe(0);
    }
  });

  it("cannot be used to launder a failing provider into a pass", () => {
    // Nine genuine failures plus one harness error must not become 0/1.
    const log = [
      ...runs(9, { passed: false, failureReason: "contract_violated" }),
      ...runs(1, { passed: false, failureReason: "harness_error" }),
      ...runs(10, { passed: true, failureReason: null, providerId: "opencode-zen" }),
    ];
    const gate = evaluateFlagshipGate(log, { scenarioId: "flagship-build-v1" });
    expect(gate.passed).toBe(false);
    expect(gate.providers.find((p) => p.providerId === "deepseek")).toMatchObject({ passes: 0, qualified: false });
  });
});
