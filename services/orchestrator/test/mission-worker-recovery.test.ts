import { describe, expect, it } from "vitest";
import { decideWorkerRecovery } from "../src/mission/worker-recovery.js";

describe("durable mission worker recovery", () => {
  it("blocks a non-retryable payment failure after the first worker", () => {
    expect(decideWorkerRecovery({
      taskId: "task-1",
      status: "interrupted",
      reason: "provider_recovery_required",
      message: "Insufficient Balance",
      provider: { kind: "provider", retryable: false, status: 402, retryAfterMs: null },
      priorDecisions: [],
      alternateProviders: 0,
    })).toMatchObject({
      category: "provider_failure",
      action: "block_precisely",
      exhausted: true,
      nextStrategyFingerprint: null,
    });
  });

  it("switches away from a non-retryable provider when a configured alternate exists", () => {
    expect(decideWorkerRecovery({
      taskId: "task-1",
      status: "interrupted",
      reason: "provider_recovery_required",
      message: "Insufficient Balance",
      provider: { kind: "provider", retryable: false, status: 402, retryAfterMs: null },
      priorDecisions: [],
      alternateProviders: 1,
    })).toMatchObject({
      category: "provider_failure",
      action: "switch_provider",
      exhausted: false,
      nextStrategyFingerprint: "provider:fallback",
    });
  });

  it("does not override an explicitly pinned provider or model", () => {
    expect(decideWorkerRecovery({
      taskId: "task-pinned-provider",
      status: "interrupted",
      reason: "provider_recovery_required",
      message: "Insufficient Balance",
      provider: { kind: "provider", retryable: false, status: 402, retryAfterMs: null },
      priorDecisions: [],
      alternateProviders: 2,
      allowProviderSwitch: false,
    })).toMatchObject({ action: "block_precisely", exhausted: true });

    expect(decideWorkerRecovery({
      taskId: "task-pinned-model",
      status: "interrupted",
      reason: "provider_recovery_required",
      message: "Unknown model",
      provider: null,
      priorDecisions: [],
      alternateProviders: 0,
      allowProviderSwitch: false,
      allowModelSwitch: false,
    })).toMatchObject({ action: "block_precisely", exhausted: true });
  });

  it("bounds retryable provider failures instead of dispatching forever", () => {
    const input = {
      taskId: "task-4",
      status: "interrupted" as const,
      reason: "provider_recovery_required",
      message: "Upstream unavailable",
      provider: { kind: "provider", retryable: true, status: 503, retryAfterMs: null },
      alternateProviders: 0,
    };
    expect(decideWorkerRecovery({ ...input, priorDecisions: [] })).toMatchObject({
      action: "retry_same_provider",
      exhausted: false,
    });
    expect(decideWorkerRecovery({
      ...input,
      priorDecisions: [
        { category: "provider_failure" },
        { category: "provider_failure" },
        { category: "provider_failure" },
      ],
    })).toMatchObject({ action: "block_precisely", exhausted: true });
  });

  it("preserves a provider retry window for rate limits", () => {
    expect(decideWorkerRecovery({
      taskId: "task-rate",
      status: "interrupted",
      reason: "provider_recovery_required",
      message: "Rate limited",
      provider: { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: 30_000 },
      priorDecisions: [],
      alternateProviders: 0,
    })).toMatchObject({
      category: "rate_limit",
      action: "await_retry_condition",
      retryCondition: expect.stringContaining("30000"),
      exhausted: false,
    });
  });

  it("bounds repeated process interruption recovery", () => {
    const decision = decideWorkerRecovery({
      taskId: "task-restart",
      status: "interrupted",
      reason: "process_interruption",
      message: "Orchestrator restart",
      provider: null,
      priorDecisions: [
        { category: "process_interruption" },
        { category: "process_interruption" },
        { category: "process_interruption" },
      ],
      alternateProviders: 0,
    });
    expect(decision).toMatchObject({ action: "block_precisely", exhausted: true });
  });
});
