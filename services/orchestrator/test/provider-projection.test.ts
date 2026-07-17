import { describe, expect, it } from "vitest";
import type { ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";
import { projectMinimalContinuation, projectProviderRequest } from "../src/execution/provider-projection.js";
import * as providerProjectionModule from "../src/execution/provider-projection.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";

const snapshot: ExecutionCheckpointSnapshot = {
  version: 1,
  originalMission: "Implement durable segmented execution.",
  hardRequirements: ["Preserve every requirement", "Run verification"],
  prohibitedActions: ["Do not merge"],
  acceptanceCriteria: ["Exactly one final answer"],
  decisions: ["Use checkpoint projection"],
  completedWork: ["route resolver implemented"],
  currentPhase: "implementation",
  filesChanged: ["src/execution.ts"],
  gitStatus: " M src/execution.ts",
  tests: [{ command: "pnpm test", exitCode: 1, result: "one failure" }],
  unresolvedFailures: ["restart regression"],
  recoveryAttempts: ["provider timeout once"],
  pendingWork: ["fix restart", "rerun tests"],
  approvals: { filesystem: "approved" },
  taskId: "task-1",
  missionId: "mission-1",
  providerRouting: { providerId: "deepseek", model: "deepseek-v4-flash" },
  providerContinuationRefs: ["opaque-private-row"],
  evidenceRequired: ["tests pass"],
};

const resolution = resolveModelBudget({
  providerId: "deepseek",
  selectedModel: "deepseek-v4-flash",
  endpoint: {
    kind: "default",
    host: "api.deepseek.com",
    protocol: "openai-chat",
    limitTokens: 131_072,
    limitSource: "provider-metadata",
  },
  outputBudgetTokens: 16_384,
});

describe("durable provider projection", () => {
  it("exposes one deterministic durable-turn reconstruction boundary", () => {
    expect((providerProjectionModule as any).buildProviderProjection).toBeTypeOf("function");
    expect((providerProjectionModule as any).projectionFingerprint).toBeTypeOf("function");
  });

  it("projects discrete narration and each tool observation exactly once with linear growth", () => {
    const buildProviderProjection = (providerProjectionModule as any).buildProviderProjection as (input: any) => Array<{ role: string; content: string }>;
    const fixture = (count: number) => ({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: Array.from({ length: count }, (_, index) => ({
        turnKey: `turn-${index + 1}`,
        assistantText: `narration-${index + 1}`,
        toolCalls: [{ id: `call-${index + 1}`, name: "read_file", arguments: JSON.stringify({ path: `${index + 1}.txt` }) }],
      })),
      toolResults: Array.from({ length: count }, (_, index) => ({ id: `call-${index + 1}`, toolName: "read_file", result: `observation-${index + 1}` })),
    });

    const ten = buildProviderProjection(fixture(10));
    const twenty = buildProviderProjection(fixture(20));
    expect(ten.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(Array.from({ length: 10 }, (_, index) => `narration-${index + 1}`));
    expect(ten.filter((message) => message.role === "tool")).toHaveLength(10);
    expect(twenty.filter((message) => message.role === "tool")).toHaveLength(20);
    expect(new Set(twenty.filter((message: any) => message.role === "tool").map((message: any) => message.toolCallId)).size).toBe(20);
  });

  it("rebuilds identical durable records byte-for-byte", () => {
    const buildProviderProjection = (providerProjectionModule as any).buildProviderProjection as (input: any) => unknown;
    const projectionFingerprint = (providerProjectionModule as any).projectionFingerprint as (messages: unknown) => string;
    const input = {
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{ turnKey: "turn-1", assistantText: "first", toolCalls: [] }],
      toolResults: [],
    };
    const first = buildProviderProjection(input);
    const second = buildProviderProjection(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(projectionFingerprint(second)).toBe(projectionFingerprint(first));
  });

  it("compacts from the structured checkpoint when the complete envelope crosses the threshold", () => {
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "Execution kernel rules" },
          { role: "user", content: "old context ".repeat(35_000) },
          { role: "assistant", content: "recent work", toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", toolCallId: "call-1", content: "recent observation" },
        ],
        tools: [{ name: "large_tool", description: "schema ".repeat(4_000), parameters: { type: "object", properties: {} } }],
        outputReserveTokens: 16_384,
      },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });

    expect(result.compacted).toBe(true);
    expect(result.admission.ok).toBe(true);
    const projection = result.envelope.messages.map((message) => message.content).join("\n");
    expect(projection).toContain("Implement durable segmented execution");
    expect(projection).toContain("Preserve every requirement");
    expect(projection).toContain("restart regression");
    expect(projection).toContain("recent observation");
    expect(projection).not.toContain("old context old context");
    expect(projection).not.toContain("opaque-private-row");
  });

  it("is byte-idempotent for an unchanged checkpoint and durable turn set", () => {
    const input = {
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat" as const,
        messages: [
          { role: "system" as const, content: "rules" },
          { role: "user" as const, content: "history ".repeat(60_000) },
          { role: "user" as const, content: "current request" },
        ],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    };
    const first = projectProviderRequest(input);
    const second = projectProviderRequest(input);
    expect(JSON.stringify(second.envelope)).toBe(JSON.stringify(first.envelope));
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("escalates to a truncated last group when a giant tool result blocks admission", () => {
    // Standard compaction keeps the last raw group verbatim; a single enormous
    // tool observation there made beta.31 throw "cannot fit the verified
    // endpoint limit after automatic compaction" and demand /continue.
    const result = projectMinimalContinuation({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "Execution kernel rules" },
          { role: "user", content: "old context ".repeat(35_000) },
          { role: "assistant", content: "recent work", toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", toolCallId: "call-1", content: "giant observation ".repeat(60_000) },
        ],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
    });
    expect(result.admission.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.truncatedToolResults).toBe(1);
    expect(result.droppedRawHistory).toBe(false);
    const text = result.envelope.messages.map((m) => m.content).join("\n");
    expect(text).toContain("Implement durable segmented execution");
    expect(text).toContain("truncated for context rollover");
  });

  it("escalates to checkpoint-only continuation when even the truncated group cannot fit", () => {
    const tiny = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "hy3-free",
      endpoint: { kind: "custom", host: "opencode.ai", protocol: "openai-chat", limitTokens: 3_000, limitSource: "endpoint-override" },
      outputBudgetTokens: 512,
    });
    const result = projectMinimalContinuation({
      checkpoint: snapshot,
      envelope: {
        providerId: "openai-compatible",
        model: "hy3-free",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "history ".repeat(30_000) },
          { role: "assistant", content: "recent narration ".repeat(500), toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", toolCallId: "call-1", content: "observation ".repeat(2_000) },
        ],
        tools: [],
        outputReserveTokens: 512,
      },
      resolution: tiny,
    });
    expect(result.admission.ok).toBe(true);
    expect(result.droppedRawHistory).toBe(true);
    const text = result.envelope.messages.map((m) => m.content).join("\n");
    // The mission contract survives the hard rollover.
    expect(text).toContain("Implement durable segmented execution");
    expect(text).toContain("Do not repeat operations already recorded as completed");
    expect(text).not.toContain("recent narration recent narration");
  });

  it("counts tool schemas before deciding whether compaction is required", () => {
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "history ".repeat(25_000) },
          { role: "user", content: "current" },
        ],
        tools: [{ name: "large_tool", description: "schema ".repeat(20_000), parameters: { type: "object", properties: {} } }],
        outputReserveTokens: 16_384,
      },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });
    expect(result.originalMeasurement.components.toolSchemas).toBeGreaterThan(20_000);
    expect(result.compacted).toBe(true);
  });
});
