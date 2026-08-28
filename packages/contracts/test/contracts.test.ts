import { describe, expect, it } from "vitest";
import {
  HealthSchema,
  RuntimeCapabilityStatusSchema,
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
  WebTaskReasoningSchema,
  UpdateRoutineSchema,
  CreateScheduleSchema,
  ScheduleSchema,
  ScheduleRunSchema,
  UpdateScheduleSchema,
  CreateMemoryEntrySchema,
  SkillCatalogEntrySchema,
  SkillCatalogIssueSchema,
  SkillCatalogStatusSchema,
  SetSkillActivationSchema,
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
  it("accepts strict catalog state and rejects unknown activation fields", () => {
    expect(SkillCatalogEntrySchema.parse({
      key: "user:calendar",
      id: "calendar",
      name: "Calendar",
      description: "Manage calendar work.",
      source: "user",
      enabled: false,
      validation: "healthy",
      issues: [],
      loadable: false,
      manifestDigest: "a".repeat(64),
      category: "productivity",
      trustTier: "controlled",
      tools: [],
      permissions: [],
      dependencies: [],
      publisher: "local",
    })).toMatchObject({ key: "user:calendar", loadable: false });
    expect(SkillCatalogIssueSchema.parse({ code: "missing_skill_md", message: "missing SKILL.md" })).toEqual({
      code: "missing_skill_md",
      message: "missing SKILL.md",
    });
    expect(SkillCatalogStatusSchema.parse({ healthy: true, entries: 1, loadable: 0, issues: [] })).toEqual({
      healthy: true,
      entries: 1,
      loadable: 0,
      issues: [],
    });
    expect(() => SetSkillActivationSchema.parse({ enabled: true, extra: true })).toThrow();
  });

  it("rejects a project without a workspace path", () => expect(() => CreateProjectSchema.parse({ name: "x" })).toThrow());
  it("allows only inspect_workspace tasks", () => expect(() => CreateTaskSchema.parse({ projectId: "p", kind: "shell" })).toThrow());
  it("requires a numeric ordered event sequence", () => expect(() => TaskEventSchema.parse({ id: "e", taskId: "t", sequence: "1", type: "task.created", createdAt: "x", payload: {} })).toThrow());

  it("types bounded conversation creation and explicit durable deletion confirmation", () => {
    expect(CreateConversationSchema.parse({ title: " Chat " })).toEqual({ title: "Chat" });
    expect(() => CreateConversationSchema.parse({ title: "x".repeat(201) })).toThrow();
    expect(DeleteConversationSchema.parse({ confirmation: "delete" })).toEqual({ confirmation: "delete" });
    expect(() => DeleteConversationSchema.parse({ confirmation: true })).toThrow();
  });

  it("keeps memory ownership server-derived rather than client-submitted", () => {
    expect(CreateMemoryEntrySchema.parse({ scope: "project", content: "shared" })).toEqual({ scope: "project", content: "shared" });
    expect(() => CreateMemoryEntrySchema.parse({ scope: "agent", content: "private", ownerAgentId: "forged" })).toThrow();
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

  it("exposes only strict provider-supplied reasoning entries", () => {
    const reasoning = {
      version: 1,
      taskId: "task-1",
      providerSupplied: true,
      entries: [{
        turnKey: "turn-1",
        providerId: "deepseek",
        content: "Inspect the current implementation before editing.",
        createdAt: "2026-07-22T12:00:00.000Z",
      }],
    };
    expect(WebTaskReasoningSchema.parse(reasoning)).toEqual(reasoning);
    expect(() => WebTaskReasoningSchema.parse({
      ...reasoning,
      entries: [{ ...reasoning.entries[0], opaque: { continuation: "private" } }],
    })).toThrow();
  });

  it("accepts routine edits without accepting provenance or execution history", () => {
    expect(UpdateRoutineSchema.parse({
      name: "Monthly report",
      objective: "Summarise the month.",
      steps: [{ summary: "Read the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
    })).toEqual({
      name: "Monthly report",
      objective: "Summarise the month.",
      steps: [{ summary: "Read the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
    });
    expect(UpdateRoutineSchema.safeParse({ sourceConversationId: "conversation-1" }).success).toBe(false);
    expect(UpdateRoutineSchema.safeParse({ runCount: 99 }).success).toBe(false);
  });

  it("models routine schedules and redacted durable run history", () => {
    const schedule = ScheduleSchema.parse({
      version: 1,
      id: "schedule-1",
      projectId: "project-1",
      cron: "0 9 * * 1-5",
      taskKind: "routine",
      routineId: "routine-1",
      agentId: "agent-1",
      enabled: true,
      lastRunAt: null,
      nextRunAt: "2026-08-21T09:00:00.000Z",
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(schedule.taskKind).toBe("routine");
    expect(CreateScheduleSchema.parse({ cron: "0 9 * * 1-5", routineId: "routine-1" })).toMatchObject({
      cron: "0 9 * * 1-5",
      routineId: "routine-1",
      taskKind: "routine",
    });
    expect(UpdateScheduleSchema.parse({ enabled: false, routineId: "routine-2" })).toEqual({ enabled: false, routineId: "routine-2" });
    const run = ScheduleRunSchema.parse({
      version: 1,
      id: "run-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      routineId: "routine-1",
      occurrenceAt: "2026-08-21T09:00:00.000Z",
      occurrenceKey: "2026-08-21T09:00:00.000Z",
      trigger: "scheduled",
      status: "waiting_for_approval",
      taskId: "task-1",
      errorCode: null,
      errorMessage: null,
      coalesced: true,
      createdAt: "2026-08-21T09:00:00.000Z",
      updatedAt: "2026-08-21T09:00:00.000Z",
      startedAt: null,
      completedAt: null,
    });
    expect(run.status).toBe("waiting_for_approval");
    expect(() => ScheduleRunSchema.parse({ ...run, providerOutput: "secret" })).toThrow();
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

/**
 * Health is the one thing every client reads to decide whether Morrow is
 * working. A missing runtime block would read as "fine" when it actually means
 * "this process never said", so the schema requires it.
 */
describe("runtime capability status", () => {
  const runtime = {
    version: 1 as const,
    startupReconciled: true,
    workGraphs: "ready" as const,
    scheduler: "running" as const,
    skills: { healthy: true, entries: 3, loadable: 2, issues: 0 },
  };

  it("requires health to carry a runtime block", () => {
    const health = {
      ok: true, service: "morrow-orchestrator" as const, apiVersion: 1, mockProvider: false,
      migrations: { applied: 1, latest: 1 }, time: new Date().toISOString(),
    };
    expect(() => HealthSchema.parse(health)).toThrow();
    expect(HealthSchema.parse({ ...health, runtime }).runtime.scheduler).toBe("running");
  });

  it("keeps unknown from readiness", () => {
    expect(RuntimeCapabilityStatusSchema.parse({ ...runtime, startupReconciled: false, workGraphs: "not_managed", scheduler: "not_managed" }))
      .toMatchObject({ startupReconciled: false, workGraphs: "not_managed" });
    expect(() => RuntimeCapabilityStatusSchema.parse({ ...runtime, scheduler: "probably" })).toThrow();
    expect(() => RuntimeCapabilityStatusSchema.parse({ ...runtime, extra: true })).toThrow();
  });
});
