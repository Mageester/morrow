import { describe, expect, it } from "vitest";
import type { MissionRecoveryDecision } from "@morrow/contracts";
import { decideWorkerRecovery, strategyFingerprint, type WorkerRecoveryInput } from "../src/mission/worker-recovery.js";

/**
 * Recovery must change something.
 *
 * The defect was structural rather than a missing bound: the failed-strategy
 * fingerprint was `worker:<taskId>`, and every retry runs as a *new* task, so
 * two identical strategies could never produce matching fingerprints. Repeated
 * categories were counted, but "retry the same provider" and "switch provider"
 * were indistinguishable in the ledger, and the next-strategy fingerprint was a
 * constant per category — so a strategy that had already failed could be
 * re-selected and nothing in the durable record showed that nothing had
 * changed.
 *
 * Fingerprints now describe the strategy, and a strategy already tried for a
 * category is escalated to a materially different one, or the mission stops.
 */

type Prior = Pick<MissionRecoveryDecision, "category" | "action" | "nextStrategyFingerprint">;

function prior(category: Prior["category"], action: Prior["action"], next: string | null): Prior {
  return { category, action, nextStrategyFingerprint: next };
}

function input(overrides: Partial<WorkerRecoveryInput> = {}): WorkerRecoveryInput {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    status: "interrupted",
    reason: "provider_recovery_required",
    message: "Upstream unavailable",
    provider: { kind: "provider", retryable: true, status: 503, retryAfterMs: null },
    priorDecisions: [],
    alternateProviders: 0,
    ...overrides,
  };
}

describe("strategy fingerprints describe the strategy, not the worker", () => {
  it("gives two different actions different fingerprints", () => {
    expect(strategyFingerprint("provider_failure", "retry_same_provider", "provider:retry"))
      .not.toBe(strategyFingerprint("provider_failure", "switch_provider", "provider:fallback"));
  });

  it("is stable for the same strategy across different worker tasks", () => {
    const first = decideWorkerRecovery(input({ taskId: "task-a" }));
    const second = decideWorkerRecovery(input({ taskId: "task-b" }));
    expect(first.nextStrategyFingerprint).toBe(second.nextStrategyFingerprint);
    expect(first.nextStrategyFingerprint).toContain("retry_same_provider");
  });

  it("names the strategy being abandoned, not the task id that ran it", () => {
    const decision = decideWorkerRecovery(input({
      taskId: "task-new",
      priorDecisions: [prior("provider_failure", "retry_same_provider", "strategy:provider_failure:retry_same_provider:provider:retry")],
    }));
    expect(decision.failedStrategyFingerprint).toBe("strategy:provider_failure:retry_same_provider:provider:retry");
    expect(decision.failedStrategyFingerprint).not.toContain("task-new");
  });
});

describe("a strategy already tried is never dispatched again", () => {
  it("escalates instead of retrying the same provider a second time", () => {
    const decision = decideWorkerRecovery(input({
      priorDecisions: [prior("provider_failure", "retry_same_provider", "strategy:provider_failure:retry_same_provider:provider:retry")],
    }));
    expect(decision.action).not.toBe("retry_same_provider");
    expect(decision.nextStrategyFingerprint).not.toBe("strategy:provider_failure:retry_same_provider:provider:retry");
    expect(decision.diagnosis).toContain("materially different");
  });

  it("prefers a different provider when one is permitted and available", () => {
    const decision = decideWorkerRecovery(input({
      alternateProviders: 2,
      priorDecisions: [prior("provider_failure", "retry_same_provider", "strategy:provider_failure:retry_same_provider:provider:retry")],
    }));
    expect(decision.action).toBe("switch_provider");
  });

  it("respects a pinned route: it escalates without switching provider or model", () => {
    const decision = decideWorkerRecovery(input({
      alternateProviders: 2,
      allowProviderSwitch: false,
      allowModelSwitch: false,
      priorDecisions: [prior("provider_failure", "retry_same_provider", "strategy:provider_failure:retry_same_provider:provider:retry")],
    }));
    expect(decision.action).not.toBe("switch_provider");
    expect(decision.action).not.toBe("switch_model");
    expect(["compact_context", "replan", "restore_checkpoint"]).toContain(decision.action);
  });

  it("produces a strictly new strategy on every successive attempt", () => {
    const priors: Prior[] = [];
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const decision = decideWorkerRecovery(input({ alternateProviders: 1, priorDecisions: [...priors] }));
      if (decision.exhausted) {
        expect(decision.action).toBe("block_precisely");
        break;
      }
      expect(seen.has(decision.nextStrategyFingerprint!), `attempt ${attempt} repeated ${decision.nextStrategyFingerprint}`).toBe(false);
      seen.add(decision.nextStrategyFingerprint!);
      priors.push(prior("provider_failure", decision.action, decision.nextStrategyFingerprint));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("stops explicitly when no materially different strategy remains", () => {
    const decision = decideWorkerRecovery(input({
      allowProviderSwitch: false,
      allowModelSwitch: false,
      priorDecisions: [
        prior("provider_failure", "retry_same_provider", "strategy:provider_failure:retry_same_provider:provider:retry"),
        prior("provider_failure", "compact_context", "strategy:provider_failure:compact_context:context:compact"),
        prior("provider_failure", "replan", "strategy:provider_failure:replan:worker:alternate-strategy"),
      ],
    }));
    // Fourth attempt for this category is past the automatic bound anyway, and
    // every remaining ladder step has been used.
    expect(decision.action).toBe("block_precisely");
    expect(decision.exhausted).toBe(true);
    expect(decision.nextStrategyFingerprint).toBeNull();
  });
});

describe("waiting out a provider cooldown stays a legitimate repeat", () => {
  it("does not escalate a second rate limit away from its retry window", () => {
    const decision = decideWorkerRecovery(input({
      reason: "provider_recovery_required",
      message: "Rate limited",
      provider: { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: 30_000 },
      priorDecisions: [prior("rate_limit", "await_retry_condition", "strategy:rate_limit:await_retry_condition:provider:retry-after")],
    }));
    expect(decision.action).toBe("await_retry_condition");
    expect(decision.retryCondition).toContain("30000");
    expect(decision.exhausted).toBe(false);
  });

  it("still bounds repeated rate limits", () => {
    const repeat = prior("rate_limit", "await_retry_condition", "strategy:rate_limit:await_retry_condition:provider:retry-after");
    const decision = decideWorkerRecovery(input({
      message: "Rate limited",
      provider: { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: 30_000 },
      priorDecisions: [repeat, repeat, repeat],
    }));
    expect(decision.exhausted).toBe(true);
    expect(decision.action).toBe("block_precisely");
  });
});
