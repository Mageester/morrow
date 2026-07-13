import { describe, expect, it } from "vitest";
import {
  CreateProjectSchema, CreateTaskSchema, TaskEventSchema,
  MissionContractSchema, MissionRequirementNodeSchema, MissionCursorSchema,
  CreateMissionSchema, MissionSchema, MissionEventTypeSchema,
  RequirementCategorySchema, RequirementNodeStatusSchema,
} from "../src/index.js";

function validNode(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "req-1",
    missionId: "m1",
    order: 0,
    statement: "do the thing",
    category: "objective",
    sourcePromptExcerpt: "do the thing",
    source: "user",
    confidence: 1,
    approved: true,
    authoritative: true,
    status: "pending",
    dependencies: [],
    evidenceRefs: [],
    affectedFiles: [],
    verifiedFileHashes: [],
    attempts: 0,
    lastFailure: null,
    completedAt: null,
    invalidationHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("contracts", () => {
  it("rejects a project without a workspace path", () => expect(() => CreateProjectSchema.parse({ name: "x" })).toThrow());
  it("allows only inspect_workspace tasks", () => expect(() => CreateTaskSchema.parse({ projectId: "p", kind: "shell" })).toThrow());
  it("requires a numeric ordered event sequence", () => expect(() => TaskEventSchema.parse({ id: "e", taskId: "t", sequence: "1", type: "task.created", createdAt: "x", payload: {} })).toThrow());
});

describe("Advanced Execution Kernel — contract schemas (R1, R2, R16)", () => {
  it("accepts a fully-specified valid contract", () => {
    const result = MissionContractSchema.safeParse({
      version: 1,
      missionId: "m1",
      sourcePrompt: "Ship the payment retry queue",
      objective: "Ship the payment retry queue",
      expectedArtifacts: ["retry-queue.ts"],
      acceptanceCriteria: ["queue drains within 5s"],
      verificationCommands: ["pnpm test"],
      requiredGitResult: "clean-working-tree",
      requirements: [validNode()],
      unresolvedAmbiguities: [],
      frozen: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a contract missing the verbatim source prompt", () => {
    const r = MissionContractSchema.safeParse({
      version: 1, missionId: "m1", objective: "x", requirements: [validNode()],
      unresolvedAmbiguities: [], frozen: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a contract missing the authoritative objective", () => {
    const r = MissionContractSchema.safeParse({
      version: 1, missionId: "m1", sourcePrompt: "x", requirements: [validNode()],
      unresolvedAmbiguities: [], frozen: false,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a requirement node with an unknown category", () => {
    expect(() => MissionRequirementNodeSchema.parse(validNode({ category: "wish" }))).toThrow();
    expect(() => MissionRequirementNodeSchema.parse(validNode({ status: "maybe" }))).toThrow();
  });

  it("accepts a complete requirement node with all persisted fields", () => {
    expect(MissionRequirementNodeSchema.safeParse(validNode({
      category: "expected_artifact",
      status: "verified",
      dependencies: ["req-0"],
      evidenceRefs: ["ev-1"],
      affectedFiles: ["src/a.ts"],
      verifiedFileHashes: ["sha256:abc"],
      attempts: 2,
      lastFailure: "boom",
      completedAt: "2026-01-02T00:00:00.000Z",
      invalidationHistory: [{
        condition: "file_hash_changed",
        reason: "hash drifted",
        invalidatedAt: "2026-01-03T00:00:00.000Z",
        evidenceRef: null,
      }],
    })).success).toBe(true);
  });

  it("accepts a complete mission cursor", () => {
    expect(MissionCursorSchema.safeParse({
      version: 1, missionId: "m1", activeNodeId: "req-1", activeObjective: "do it",
      allowedNextActions: ["verify_requirement"], blockedReason: null, lastCompletedAction: "start_requirement",
      frozenNodeIds: ["req-2"], invalidatedNodeIds: [], updatedAt: "2026-01-01T00:00:00.000Z",
    }).success).toBe(true);
  });

  it("accepts CreateMission with and without a structured contract", () => {
    expect(CreateMissionSchema.safeParse({ objective: "do x" }).success).toBe(true);
    expect(CreateMissionSchema.safeParse({
      objective: "do x",
      contract: { expectedArtifacts: ["a.ts"], acceptanceCriteria: ["works"], verificationCommands: ["test"], requiredGitResult: "clean", prohibitions: ["no force-push"] },
    }).success).toBe(true);
  });

  it("keeps the existing MissionSchema and terminal event identity compatible (R16)", () => {
    expect(MissionSchema.safeParse({
      version: 1, id: "m1", projectId: "p1", objective: "x", status: "draft",
      autoApprove: false, criteria: [], taskTreeRootId: null,
      budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
      checkpoints: [], evidence: [], failures: [], finalReview: null, result: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null,
    }).success).toBe(true);
    for (const t of ["mission.contract_built", "mission.requirement_reopened", "mission.requirement_status_changed"]) {
      expect(MissionEventTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(RequirementCategorySchema.safeParse("prohibited_action").success).toBe(true);
    expect(RequirementNodeStatusSchema.safeParse("invalidated").success).toBe(true);
  });
});
