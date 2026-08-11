import { describe, expect, it } from "vitest";
import { ImprovementProposalSchema, OptimizationMetricsSchema } from "../src/improvements.js";

const proposal = {
  id: "proposal-1",
  version: 1,
  observedProblem: "The full tool catalog adds unrelated schemas to read-only tasks.",
  proposedChange: {
    kind: "tool-profile",
    description: "Use the smallest safe workspace-read profile.",
    profile: "read-only-workspace",
  },
  evidenceTaskIds: ["task-1", "task-2"],
  benchmarkFixtureIds: ["fixture-read-only"],
  expectedEffect: {
    metric: "tool_schema_tokens",
    baseline: 480,
    target: 120,
    acceptanceCriterion: "Preserve task outcome while reducing tool-schema tokens.",
  },
  privacyImpact: {
    summary: "No new provider, network, filesystem, or tool authority.",
    networkAccess: "unchanged",
    permissionChange: "none",
  },
  rolloutState: "proposed",
  rollbackReference: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("improvement contracts", () => {
  it("accepts a versioned evidence-backed proposal with an explicit rollback reference", () => {
    expect(ImprovementProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("rejects a proposal that has no durable task or fixture evidence", () => {
    const invalid = { ...proposal, evidenceTaskIds: [], benchmarkFixtureIds: [] };
    expect(ImprovementProposalSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps unavailable optimization measurements null instead of inventing zeroes", () => {
    const metrics = OptimizationMetricsSchema.parse({
      providerAttempts: 2,
      duplicateObservations: null,
      retries: 1,
      compactions: 0,
      toolSchemaTokens: null,
      wallClockMs: 1_500,
      interventionCount: null,
      costAccuracy: "unknown",
      privacyOutcome: "passed",
      reliabilityOutcome: "passed",
      verificationOutcome: "passed",
    });

    expect(metrics).toMatchObject({
      duplicateObservations: null,
      toolSchemaTokens: null,
      interventionCount: null,
      costAccuracy: "unknown",
    });
  });
});
