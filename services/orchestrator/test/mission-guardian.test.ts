import { describe, expect, it } from "vitest";
import { evaluateGuardian, type GuardianInput } from "../src/mission/guardian.js";

function fixture(overrides: Partial<GuardianInput> = {}): GuardianInput {
  return {
    missionId: "mission-1",
    criteria: [{ id: "criterion-1", state: "verified", evidenceIds: ["evidence-1"] }],
    requirements: [{ id: "requirement-1", authoritative: true, status: "verified", evidenceRefs: ["evidence-1"] }],
    evidence: [{ id: "evidence-1", criterionIds: ["criterion-1"], status: "passed" }],
    operations: [{ id: "operation-1", status: "completed", effectEvidenceIds: ["evidence-1"] }],
    tasks: [{ id: "task-1", status: "completed" }],
    approvals: [],
    canonicalAnswer: {
      required: true,
      present: true,
      durableEvidenceValid: true,
      verificationPassed: true,
      unresolvedBlocker: null,
      unresolvedFailures: [],
    },
    reviewVerdict: "approved",
    requiredValidationKinds: ["tests"],
    completedValidationKinds: ["tests"],
    changedFiles: ["src/index.ts"],
    diffChecked: true,
    protectedPathViolations: [],
    ...overrides,
  };
}

describe("mission Guardian", () => {
  it("rejects a final-looking answer and returns the required criterion action", () => {
    const decision = evaluateGuardian(fixture({
      criteria: [{ id: "criterion-1", state: "unverified", evidenceIds: [] }],
      canonicalAnswer: {
        required: true,
        present: true,
        durableEvidenceValid: true,
        verificationPassed: true,
        unresolvedBlocker: null,
        unresolvedFailures: [],
      },
    }));

    expect(decision.passed).toBe(false);
    expect(decision.missing).toContainEqual(expect.objectContaining({
      kind: "criterion",
      criterionId: "criterion-1",
    }));
    expect(decision.nextActions).toContain("validate_criteria");
  });

  it("passes only when every independent completion class is satisfied", () => {
    const decision = evaluateGuardian(fixture());

    expect(decision.passed).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.failed).toEqual([]);
    expect(decision.blocked).toEqual([]);
    expect(decision.evidenceSnapshot).toMatchObject({
      criteria: { total: 1, satisfied: 1 },
      requirements: { authoritative: 1, satisfied: 1 },
      evidence: { passed: 1, failed: 0 },
      operations: { resolved: 1, unresolved: 0 },
    });
  });

  it("blocks on unresolved operations, workers, approvals, and canonical evidence", () => {
    const decision = evaluateGuardian(fixture({
      operations: [{ id: "operation-1", status: "unknown_effect", effectEvidenceIds: [] }],
      tasks: [{ id: "task-1", status: "running" }],
      approvals: [{ id: "approval-1", status: "pending" }],
      canonicalAnswer: {
        required: true,
        present: true,
        durableEvidenceValid: false,
        verificationPassed: false,
        unresolvedBlocker: "tool effect unknown",
        unresolvedFailures: ["verification failed"],
      },
    }));

    expect(decision.passed).toBe(false);
    expect(decision.blocked.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "operation",
      "task",
      "approval",
      "canonical_answer",
    ]));
    expect(decision.nextActions).toEqual(expect.arrayContaining([
      "reconcile_operations",
      "wait_for_workers",
      "resolve_approvals",
      "repair_canonical_answer",
    ]));
  });

  it("fails protected-path and validation-class gaps", () => {
    const decision = evaluateGuardian(fixture({
      requiredValidationKinds: ["tests", "browser"],
      completedValidationKinds: ["tests"],
      protectedPathViolations: [".morrow/secrets.json"],
    }));

    expect(decision.failed).toContainEqual(expect.objectContaining({ kind: "protected_path" }));
    expect(decision.missing).toContainEqual(expect.objectContaining({ kind: "validation", id: "browser" }));
    expect(decision.nextActions).toEqual(expect.arrayContaining(["repair_protected_paths", "run_required_validation"]));
  });
});
