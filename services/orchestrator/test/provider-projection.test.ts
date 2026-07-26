import { describe, expect, it } from "vitest";
import type { ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";
import { projectProviderRequest } from "../src/execution/provider-projection.js";
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

const PRESSURE_FIXTURE_NAMES = [
  "read_file", "search_text", "list_files", "run_command", "create_file",
  "propose_patch", "git_status", "git_diff", "read_process_output", "stop_process",
];

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

  it("compacts completed write arguments but preserves failed write bodies for repair", () => {
    const buildProviderProjection = providerProjectionModule.buildProviderProjection;
    const body = "full file body";
    const messages = buildProviderProjection({
      prefixMessages: [],
      turns: [{
        turnKey: "turn-1",
        assistantText: "",
        toolCalls: [
          { id: "completed", name: "create_file", arguments: JSON.stringify({ path: "done.ts", content: body }) },
          { id: "failed", name: "create_file", arguments: JSON.stringify({ path: "retry.ts", content: body }) },
        ],
      }],
      toolResults: [
        { id: "completed", toolName: "create_file", result: "ok", status: "completed" },
        { id: "failed", toolName: "create_file", result: "bad path", status: "failed" },
      ],
      normalizeToolArguments: (_name, args) => JSON.stringify({ normalizedBytes: args.length }),
    });
    const calls = messages.find((message) => message.role === "assistant")!.toolCalls!;
    expect(JSON.parse(calls.find((call) => call.id === "completed")!.function.arguments)).toHaveProperty("normalizedBytes");
    expect(JSON.parse(calls.find((call) => call.id === "failed")!.function.arguments)).toEqual({
      path: "retry.ts",
      content: body,
    });
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

  it("compacts an oversized newest tool batch instead of rejecting the route", () => {
    const calls = Array.from({ length: 12 }, (_, index) => ({
      id: `read-${index}`,
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: `${index}.ts` }) },
    }));
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "old context ".repeat(35_000) },
          { role: "assistant", content: "Read every source file", toolCalls: calls },
          ...calls.map((call) => ({ role: "tool" as const, name: "read_file", toolCallId: call.id, content: "source contents ".repeat(3_000) })),
        ],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });
    expect(result.compacted).toBe(true);
    expect(result.admission.ok).toBe(true);
    const projection = result.envelope.messages.map((message) => message.content).join("\n");
    expect(projection).toContain("latest completed execution batch");
    expect(projection).toContain("read_file: completed");
    expect(projection).not.toContain("source contents source contents");
  });

  it("bounds dependency-heavy checkpoint file and git status data", () => {
    const noisySnapshot = {
      ...snapshot,
      filesChanged: Array.from({ length: 1_000 }, (_, index) => `node_modules/package-${index}/dist/generated-file.js`),
      gitStatus: Array.from({ length: 1_000 }, (_, index) => `?? node_modules/package-${index}/dist/generated-file.js`).join("\n"),
    };
    const result = projectProviderRequest({
      checkpoint: noisySnapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [{ role: "user", content: "history ".repeat(50_000) }, { role: "user", content: "run build and tests" }],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });
    expect(result.admission.ok).toBe(true);
    const projection = result.envelope.messages.map((message) => message.content).join("\n");
    expect(projection).toContain("package-999");
    expect(projection).not.toContain("package-100/");
    expect(Buffer.byteLength(projection, "utf8")).toBeLessThan(12_000);
  });

  it("replaces generated checkpoint messages across repeated segment projections", () => {
    const first = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [{ role: "system", content: "Original agent instructions" }, { role: "user", content: "history ".repeat(50_000) }],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
      forceCompaction: true,
    });
    const second = projectProviderRequest({
      checkpoint: { ...snapshot, currentPhase: "verification" },
      envelope: { ...first.envelope, messages: [...first.envelope.messages, { role: "user", content: "continue" }] },
      resolution,
      forceCompaction: true,
    });
    const projection = second.envelope.messages.map((message) => message.content).join("\n");

    expect(projection.match(/Morrow durable execution checkpoint\./g)).toHaveLength(1);
    expect(projection).toContain("Original agent instructions");
    expect(projection).toContain("verification");
  });

  it("reduces optional tool schemas when compacted core still exceeds a small route", () => {
    const smallResolution = resolveModelBudget({
      providerId: "opencode-zen",
      selectedModel: "deepseek-v4-flash-free",
      endpoint: { kind: "default", host: "opencode.ai", protocol: "openai-chat", limitTokens: 32_768, limitSource: "provider-metadata" },
      outputBudgetTokens: 4_096,
    });
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "opencode-zen",
        model: "deepseek-v4-flash-free",
        protocol: "openai-chat",
        messages: [{ role: "user", content: "history ".repeat(30_000) }, { role: "user", content: "finish build and tests" }],
        tools: Array.from({ length: 30 }, (_, index) => ({
          name: PRESSURE_FIXTURE_NAMES[index] ?? `optional_${index}`,
          description: "schema detail ".repeat(250),
          parameters: { type: "object", properties: { value: { type: "string", description: "x".repeat(100) } } },
        })),
        outputReserveTokens: 4_096,
      },
      resolution: smallResolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });
    expect(result.admission.ok).toBe(true);
    expect(result.envelope.tools.length).toBeLessThan(30);
    expect(result.envelope.tools.map((tool) => tool.name)).toContain("run_command");
  });
});
