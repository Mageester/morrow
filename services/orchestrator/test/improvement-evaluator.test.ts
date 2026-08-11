import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { improvementProposalsRepository } from "../src/repositories/improvement-proposals.js";
import { ImprovementEvaluator } from "../src/optimization/improvement-evaluator.js";

function draft() {
  return {
    observedProblem: "Read-only tasks spend input tokens on unrelated tool schemas.",
    proposedChange: {
      kind: "tool-profile" as const,
      description: "Select read-only-workspace for workspace inspection.",
      profile: "read-only-workspace",
    },
    evidenceTaskIds: ["task-1"],
    benchmarkFixtureIds: ["fixture-1"],
    expectedEffect: {
      metric: "tool_schema_tokens" as const,
      baseline: 100,
      target: 50,
      acceptanceCriterion: "No outcome, privacy, reliability, or verification regression.",
    },
    privacyImpact: {
      summary: "No authority or external-data change.",
      networkAccess: "unchanged" as const,
      permissionChange: "none" as const,
    },
  };
}

describe("evidence-backed improvement evaluation", () => {
  it("only creates proposals when durable task and fixture evidence is present", () => {
    const db = openDatabase(":memory:");
    const evaluator = new ImprovementEvaluator(improvementProposalsRepository(db));

    expect(() => evaluator.createProposal({ ...draft(), evidenceTaskIds: [] })).toThrow(/evidence/i);
    expect(evaluator.createProposal(draft()).evidenceTaskIds).toEqual(["task-1"]);
    db.close();
  });

  it("evaluates in shadow mode and promotes only after a clean measured result", () => {
    const db = openDatabase(":memory:");
    const repository = improvementProposalsRepository(db);
    const evaluator = new ImprovementEvaluator(repository);
    const proposal = evaluator.createProposal(draft());

    const evaluation = evaluator.evaluateInShadow(proposal.id, {
      fixtureId: "fixture-1",
      baseline: { outcome: "passed", privacy: "passed", reliability: "passed", verification: "passed", toolSchemaTokens: 100 },
      candidate: { outcome: "passed", privacy: "passed", reliability: "passed", verification: "passed", toolSchemaTokens: 50 },
    });

    expect(evaluation.mode).toBe("shadow");
    expect(evaluation.promotable).toBe(true);
    expect(repository.get(proposal.id)?.rolloutState).toBe("evaluated");

    const approved = repository.approve(proposal.id, { actor: "user", note: "Reviewed benchmark evidence." });
    expect(approved.rolloutState).toBe("approved");
    expect(approved.version).toBe(2);
    db.close();
  });

  it("keeps a privacy regression out of promotion and durably records reject and rollback versions", () => {
    const db = openDatabase(":memory:");
    const repository = improvementProposalsRepository(db);
    const evaluator = new ImprovementEvaluator(repository);
    const proposal = evaluator.createProposal(draft());

    const evaluation = evaluator.evaluateInShadow(proposal.id, {
      fixtureId: "fixture-1",
      baseline: { outcome: "passed", privacy: "passed", reliability: "passed", verification: "passed", toolSchemaTokens: 100 },
      candidate: { outcome: "passed", privacy: "regressed", reliability: "passed", verification: "passed", toolSchemaTokens: 20 },
    });

    expect(evaluation.promotable).toBe(false);
    expect(evaluation.reason).toMatch(/privacy|regression/i);
    expect(repository.reject(proposal.id, { actor: "user", note: "Privacy regression." })).toMatchObject({ version: 2, rolloutState: "rejected" });
    expect(repository.rollback(proposal.id, { actor: "user", reference: "proposal-1@1" })).toMatchObject({ version: 3, rolloutState: "rolled_back", rollbackReference: "proposal-1@1" });
    db.close();
  });
});
