import { describe, it, expect } from "vitest";
import {
  PresetSchema,
  ProviderStatusSchema,
  RoutingDecisionSchema,
  MemoryEntrySchema,
  ExecutionDisclosureSchema,
  AgentExecutionStateSchema,
  ApprovalSchema,
  ResolveApprovalSchema,
  TaskStatusSchema,
  SendMessageSchema,
  ModelInfoSchema,
  OAuthFindingSchema,
  MissionSpecialistRoleSchema,
  MissionOperationSchema,
  MissionProgressObservationSchema,
  MissionRecoveryDecisionSchema,
} from "@morrow/contracts";
import { listPresets } from "../src/routing/presets.js";
import { listProviderStatuses } from "../src/provider/registry.js";
import { listModels } from "../src/routing/models.js";
import { OAUTH_FINDINGS } from "../src/provider/oauth.js";

describe("Contract schemas", () => {
  it("validates every built-in preset, model, and provider status", () => {
    for (const preset of listPresets()) expect(() => PresetSchema.parse(preset)).not.toThrow();
    for (const model of listModels()) expect(() => ModelInfoSchema.parse(model)).not.toThrow();
    for (const status of listProviderStatuses({ OPENAI_API_KEY: "k" })) expect(() => ProviderStatusSchema.parse(status)).not.toThrow();
    for (const finding of OAUTH_FINDINGS) expect(() => OAuthFindingSchema.parse(finding)).not.toThrow();
  });

  it("enforces the full set of truthful task states", () => {
    expect(TaskStatusSchema.options).toEqual(["queued", "running", "completed", "verified", "failed", "cancelled", "interrupted"]);
  });

  it("enforces the persisted agent state machine vocabulary", () => {
    expect(AgentExecutionStateSchema.options).toEqual([
      "idle", "understanding", "planning", "waiting_for_approval", "executing_tool", "observing",
      "proposing_changes", "applying_changes", "verifying", "completed", "failed", "cancelled", "interrupted",
    ]);
  });

  it("requires an explicit project trust pattern", () => {
    const approval = { version: 1, id: "approval", taskId: "task", projectId: "project", kind: "command", status: "pending", summary: "pnpm test", details: {}, decision: null, decisionNote: null, createdAt: new Date().toISOString(), resolvedAt: null };
    expect(() => ApprovalSchema.parse(approval)).not.toThrow();
    expect(() => ResolveApprovalSchema.parse({ projectId: "project", decision: "trust_project" })).toThrow();
    expect(() => ResolveApprovalSchema.parse({ projectId: "project", decision: "trust_project", trustPattern: "pnpm test" })).not.toThrow();
  });

  it("requires specialist roles to exchange structured artifacts instead of chain-of-thought", () => {
    const role = {
      id: "planner",
      name: "Cortex Planner",
      objective: "Plan a mission",
      allowedTools: ["read_file"],
      requiredInputs: ["objective"],
      structuredOutput: "JSON plan",
      budget: { maxToolCalls: 4, maxContextBytes: 10000, maxUsd: null },
      timeoutMs: 30000,
      missionId: "mission-1",
      taskId: null,
      agentId: null,
      status: "pending",
      completionCriteria: ["Plan is evidence-backed"],
      storesChainOfThought: false,
    };
    expect(() => MissionSpecialistRoleSchema.parse(role)).not.toThrow();
    expect(() => MissionSpecialistRoleSchema.parse({ ...role, storesChainOfThought: true })).toThrow();
  });

  it("accepts every provider id in the disclosure schema", () => {
    const base = {
      version: 1 as const,
      taskId: "t1",
      executionMode: "agent-interactive" as const,
      networkAccess: "enabled" as const,
      filesystemAccess: "read-only" as const,
      shellExecution: false,
      modelInvocation: true,
      workspaceScope: "/ws",
      estimatedCostUsd: "unknown (not metered)",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const provider of ["openai", "anthropic", "gemini", "openrouter", "deepseek", "ollama", "mock"] as const) {
      expect(() => ExecutionDisclosureSchema.parse({ ...base, provider })).not.toThrow();
    }
  });

  it("rejects unknown providers in a routing decision", () => {
    const decision = {
      version: 1,
      presetId: "balanced",
      providerId: "not-a-provider",
      model: "x",
      reason: "r",
      fallbackUsed: false,
      overridden: false,
      privacy: "cloud",
      candidates: [],
    };
    expect(() => RoutingDecisionSchema.parse(decision)).toThrow();
  });

  it("validates a memory entry and rejects unknown scopes", () => {
    const entry = {
      version: 1,
      id: "m1",
      projectId: "p1",
      conversationId: null,
      scope: "project",
      content: "fact",
      source: "user",
      originTaskId: null,
      pinned: false,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => MemoryEntrySchema.parse(entry)).not.toThrow();
    expect(() => MemoryEntrySchema.parse({ ...entry, scope: "global" })).toThrow();
  });

  it("validates send-message input and rejects empty content", () => {
    expect(() => SendMessageSchema.parse({ content: "hello", preset: "balanced" })).not.toThrow();
    expect(() => SendMessageSchema.parse({ content: "   " })).toThrow();
    expect(() => SendMessageSchema.parse({ content: "hi", providerId: "nope" })).toThrow();
  });

  it("validates durable mission operation, progress, and recovery records", () => {
    const now = new Date().toISOString();
    expect(() => MissionOperationSchema.parse({
      version: 1,
      id: "operation-1",
      missionId: "mission-1",
      sequence: 1,
      idempotencyKey: "dispatch:requirement-1",
      kind: "dispatch_worker",
      status: "pending",
      strategyFingerprint: "primary:openai:gpt-5.6",
      input: { requirementId: "requirement-1" },
      result: null,
      effectEvidenceIds: [],
      attempt: 0,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    })).not.toThrow();
    expect(() => MissionProgressObservationSchema.parse({
      version: 1,
      id: "progress-1",
      missionId: "mission-1",
      operationId: "operation-1",
      kind: "uncertainty_reduced",
      summary: "Eliminated the provider-auth hypothesis.",
      evidenceIds: ["evidence-1"],
      strategyFingerprint: "diagnose:provider-auth",
      createdAt: now,
    })).not.toThrow();
    expect(() => MissionRecoveryDecisionSchema.parse({
      version: 1,
      id: "recovery-1",
      missionId: "mission-1",
      operationId: "operation-1",
      category: "provider_failure",
      diagnosis: "The selected route failed before producing a tool result.",
      failedStrategyFingerprint: "primary:openai:gpt-5.6",
      nextStrategyFingerprint: "fallback:anthropic:claude-sonnet-5",
      action: "switch_provider",
      retryCondition: null,
      exhausted: false,
      createdAt: now,
    })).not.toThrow();
  });
});
