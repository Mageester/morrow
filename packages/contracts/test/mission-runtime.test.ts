import { describe, expect, it } from "vitest";
import { MissionRecoveryDecisionSchema } from "../src/index.js";

const base = {
  version: 1 as const,
  id: "decision-1",
  missionId: "mission-1",
  operationId: null,
  diagnosis: "provider rate-limited",
  retryCondition: null,
  exhausted: false,
  createdAt: "2026-08-04T00:00:00.000Z",
};

/**
 * Reported live: a real rate-limit recovery crashed the orchestrator with a
 * raw ZodError instead of being recorded. `retry_same_provider`,
 * `switch_provider`, `switch_model`, and `await_retry_condition` all use
 * fixed, non-specific fingerprint placeholders (worker-recovery.ts's
 * strategyFingerprint: "provider:retry", "provider:fallback",
 * "model:available-alternative", "provider:retry-after") rather than one
 * that names the specific provider/model chosen — so two independently
 * legitimate decisions of the same action naturally produce an identical
 * fingerprint. The real loop-prevention bound is
 * worker-recovery.ts's MAX_AUTOMATIC_ATTEMPTS (attempt-count based) and the
 * escalation ladder's own fingerprint dedup — both independent of this
 * schema check — so narrowing this invariant to the actions that inherently
 * reuse a fingerprint does not reopen a real stuck-loop hole.
 */
describe("MissionRecoveryDecisionSchema — repeated-strategy invariant", () => {
  const exemptActions = ["retry_same_provider", "switch_model", "switch_provider", "await_retry_condition"] as const;

  it.each(exemptActions)("allows an identical fingerprint for %s", (action) => {
    const result = MissionRecoveryDecisionSchema.safeParse({
      ...base,
      category: "provider_failure",
      action,
      failedStrategyFingerprint: "strategy:provider_failure:retry_same_provider:provider:retry",
      nextStrategyFingerprint: "strategy:provider_failure:retry_same_provider:provider:retry",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects an identical fingerprint for an action that must change strategy", () => {
    const result = MissionRecoveryDecisionSchema.safeParse({
      ...base,
      category: "repeated_strategy",
      action: "replan",
      failedStrategyFingerprint: "strategy:repeated_strategy:replan:worker:alternate-strategy",
      nextStrategyFingerprint: "strategy:repeated_strategy:replan:worker:alternate-strategy",
    });
    expect(result.success).toBe(false);
  });

  it("still allows a distinct fingerprint for any action, exempt or not", () => {
    const result = MissionRecoveryDecisionSchema.safeParse({
      ...base,
      category: "context_exhaustion",
      action: "compact_context",
      failedStrategyFingerprint: "strategy:context_exhaustion:compact_context:context:compact",
      nextStrategyFingerprint: "strategy:context_exhaustion:compact_context:context:compact:2",
    });
    expect(result.success).toBe(true);
  });

  it("allows a null failed fingerprint regardless of action (first attempt, nothing to compare)", () => {
    const result = MissionRecoveryDecisionSchema.safeParse({
      ...base,
      category: "process_interruption",
      action: "restore_checkpoint",
      failedStrategyFingerprint: null,
      nextStrategyFingerprint: "strategy:process_interruption:restore_checkpoint:worker:replacement",
    });
    expect(result.success).toBe(true);
  });
});
