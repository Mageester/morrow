import { describe, expect, it } from "vitest";
import { createExecutionPolicy } from "../src/execution/execution-policy.js";

describe("free execution policy", () => {
  it("observes soft heuristics without making them terminal", () => {
    const policy = createExecutionPolicy();

    for (const signal of [
      "stagnation",
      "loop_detected",
      "duplicate_narration",
      "missing_delivery",
      "frontend_validation",
      "cleanup_pending",
      "verification_incomplete",
      "malformed_tool_arguments",
      "recoverable_tool_error",
    ] as const) {
      expect(policy.decide({ signal })).toMatchObject({ disposition: "observe", hard: false });
    }
  });

  it("only exposes caller-configured budgets", () => {
    expect(createExecutionPolicy()).toMatchObject({ turnBudget: null, segmentBudget: null });
    expect(createExecutionPolicy({ maxTurns: 3, maxAutomaticSegments: 2 })).toMatchObject({ turnBudget: 3, segmentBudget: 2 });
    expect(() => createExecutionPolicy({ maxTurns: 0 })).toThrow(/positive safe integers/);
  });

  it("keeps cancellation, authority, and unrecoverable provider edges hard", () => {
    const policy = createExecutionPolicy();

    expect(policy.decide({ signal: "user_cancelled" })).toMatchObject({ disposition: "interrupt", hard: true });
    expect(policy.decide({ signal: "approval_required" })).toMatchObject({ disposition: "wait", hard: true });
    expect(policy.decide({ signal: "permission_denied" })).toMatchObject({ disposition: "observe", hard: true });
    expect(policy.decide({ signal: "explicit_budget_exhausted" })).toMatchObject({ disposition: "interrupt", hard: true });
    expect(policy.decide({ signal: "provider_auth_failure" })).toMatchObject({ disposition: "fail", hard: true });
  });
});
