import { describe, expect, it } from "vitest";
import {
  CreateProjectSchema, CreateTaskSchema, TaskEventSchema,
  MissionContractSchema, MissionRequirementNodeSchema, MissionCursorSchema,
  CreateMissionSchema, MissionSchema, MissionEventTypeSchema,
  RequirementCategorySchema, RequirementNodeStatusSchema,
  DiscoveredModelSchema,
  ChatStreamEnvelopeSchema,
  CreateConversationSchema,
  DeleteConversationSchema,
  WebConversationRoutingSchema,
  WebConversationMessageSchema,
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

  it("types bounded conversation creation and explicit durable deletion confirmation", () => {
    expect(CreateConversationSchema.parse({ title: " Chat " })).toEqual({ title: "Chat" });
    expect(() => CreateConversationSchema.parse({ title: "x".repeat(201) })).toThrow();
    expect(DeleteConversationSchema.parse({ confirmation: "delete" })).toEqual({ confirmation: "delete" });
    expect(() => DeleteConversationSchema.parse({ confirmation: true })).toThrow();
  });

  it("keeps browser chat events coarse and canonical message tool activity secret-free", () => {
    const publicRouting = {
      version: 1,
      presetId: "balanced",
      providerId: "mock",
      model: "mock-model",
      fallbackUsed: false,
      overridden: false,
      mode: "read-only",
      autoApprove: false,
    };
    expect(WebConversationRoutingSchema.parse(publicRouting)).toEqual(publicRouting);
    expect(() => WebConversationRoutingSchema.parse({ ...publicRouting, reason: "internal provider diagnostic" })).toThrow();

    expect(ChatStreamEnvelopeSchema.parse({
      version: 1,
      cursor: 2,
      taskId: "task-1",
      conversationId: "conversation-1",
      eventType: "message.updated",
      emittedAt: "2026-07-22T12:00:00.000Z",
      payload: { eventId: "event-2" },
    }).payload).toEqual({ eventId: "event-2" });
    expect(() => ChatStreamEnvelopeSchema.parse({
      version: 1,
      cursor: 2,
      taskId: "task-1",
      conversationId: "conversation-1",
      eventType: "message.updated",
      emittedAt: "2026-07-22T12:00:00.000Z",
      payload: { eventId: "event-2", deltaText: "private" },
    })).toThrow();

    const parsed = WebConversationMessageSchema.parse({
      version: 1,
      id: "assistant-1",
      conversationId: "conversation-1",
      role: "assistant",
      content: "Canonical",
      taskId: "task-1",
      streamingState: "completed",
      provider: "mock",
      model: "mock-model",
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
      taskStatus: "completed",
      routing: null,
      toolActivity: [{ id: "tool-1", toolName: "read_file", status: "completed", startedAt: null, completedAt: "2026-07-22T12:00:00.000Z" }],
    });
    expect(parsed.toolActivity).toEqual([expect.objectContaining({ toolName: "read_file" })]);
    expect(() => WebConversationMessageSchema.parse({ ...parsed, toolActivity: [{ ...parsed.toolActivity[0], argsJson: "secret" }] })).toThrow();
  });

  it("accepts a complete provider-reported OpenRouter catalogue model", () => {
    expect(DiscoveredModelSchema.parse({
      providerModelId: "anthropic/claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      author: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      capabilities: { streaming: true, toolCalls: true, vision: true, reasoning: true },
      pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, source: "provider-reported" },
      costType: "paid",
      availability: "available",
      fetchedAt: "2026-07-22T12:00:00.000Z",
      metadataSource: "provider-reported",
    })).toMatchObject({
      author: "anthropic",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      capabilities: { toolCalls: true, reasoning: true },
      costType: "paid",
      availability: "available",
      fetchedAt: "2026-07-22T12:00:00.000Z",
    });
  });
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
