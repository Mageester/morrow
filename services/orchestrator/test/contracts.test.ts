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
});
