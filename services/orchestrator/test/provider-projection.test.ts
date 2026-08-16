import { describe, expect, it } from "vitest";
import type { ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";
import { knownCapacity } from "./known-capacity.js";
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

  it("does not forward raw legacy tool-call JSON through compaction projection", () => {
    const probe = "credential sk-abcdefghijklmnop";
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{
        turnKey: "legacy-turn",
        assistantText: "safe",
        toolCalls: [{ id: "legacy-call", name: "run_command", arguments: JSON.stringify({ nested: { secret: probe } }) }],
      }],
      toolResults: [{ id: "legacy-call", toolName: "run_command", result: JSON.stringify({ output: probe }) }],
    });
    expect(JSON.stringify(messages)).not.toContain(probe);
  });

  it("keeps a completed write request and its exact successful result in durable history", () => {
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{
        turnKey: "turn-write",
        assistantText: "I created the file.",
        toolCalls: [{
          id: "write",
          name: "create_file",
          arguments: JSON.stringify({ path: "src/app.ts", content: "export const ready = true;\n" }),
        }],
      }],
      toolResults: [{
        id: "write",
        toolName: "create_file",
        result: JSON.stringify({ created: true, path: "src/app.ts" }),
        status: "completed",
      }],
      // This is the old context-only normalization seam. A completed durable
      // write must not be converted into a Morrow replay marker at the request
      // boundary, even if an older caller still provides the normalizer.
      normalizeToolArguments: () => JSON.stringify({
        path: "src/app.ts",
        _morrowAppliedWrite: { kind: "create_file", contentBytes: 28, contentSha256: "abc" },
        truncatedForContext: true,
      }),
    });

    const assistant = messages.find((message) => message.role === "assistant");
    const tool = messages.find((message) => message.role === "tool");
    expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(["write"]);
    expect(tool?.toolCallId).toBe("write");
    expect(tool?.content).toBe(JSON.stringify({ created: true, path: "src/app.ts" }));
    expect(JSON.stringify(messages)).not.toContain("_morrowAppliedWrite");
    expect(JSON.stringify(messages)).not.toContain("Morrow durable write record.");
    expect(messages.filter((message) => message.role === "tool" && message.toolCallId === "write")).toHaveLength(1);
  });

  it("preserves completed and failed write arguments for truthful reconstruction", () => {
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
    expect(JSON.parse(calls.find((call) => call.id === "completed")!.function.arguments)).toEqual({
      path: "done.ts",
      content: body,
    });
    expect(JSON.parse(calls.find((call) => call.id === "failed")!.function.arguments)).toEqual({
      path: "retry.ts",
      content: body,
    });
  });

  it("does not turn a completed write into an applied-write marker or narration", () => {
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{
        turnKey: "turn-1",
        assistantText: "Files created.",
        toolCalls: [
          { id: "write", name: "create_file", arguments: JSON.stringify({ path: "src/app.ts", content: "export {};" }) },
          { id: "read", name: "read_file", arguments: JSON.stringify({ path: "src/app.ts" }) },
        ],
      }],
      toolResults: [
        { id: "write", toolName: "create_file", result: JSON.stringify({ created: true }), status: "completed" },
        { id: "read", toolName: "read_file", result: "export {};", status: "completed" },
      ],
      normalizeToolArguments: (name, args) => name === "create_file"
        ? JSON.stringify({
          path: "src/app.ts",
          _morrowAppliedWrite: { kind: "create_file", contentBytes: 10, contentSha256: "abc" },
          truncatedForContext: true,
        })
        : args,
    });

    const serialized = JSON.stringify(messages);
    const calls = messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.id)).toEqual(["write", "read"]);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["write", "read"]);
    expect(serialized).not.toContain("_morrowAppliedWrite");
    expect(messages.find((message) => message.role === "tool" && message.toolCallId === "write")?.content)
      .toContain('"created":true');
    expect(serialized).not.toContain("create_file completed for src/app.ts");
    expect(serialized).not.toMatch(/requirement is satisfied|do not call create_file again|read-only tool/i);
    expect(serialized).not.toContain("historical record, not a tool request");
  });

  it("keeps a completed append result as an ordinary tool observation", () => {
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{
        turnKey: "turn-append",
        assistantText: "Appended the next chunk.",
        toolCalls: [{ id: "append", name: "append_file", arguments: JSON.stringify({ path: "src/app.ts", content: "export const ready = true;\n", expectedOffset: 0 }) }],
      }],
      toolResults: [{
        id: "append",
        toolName: "append_file",
        result: JSON.stringify({ appended: true, totalBytes: 28 }),
        status: "completed",
      }],
      normalizeToolArguments: (name) => name === "append_file"
        ? JSON.stringify({
          path: "src/app.ts",
          expectedOffset: 0,
          _morrowAppliedWrite: { kind: "append_file", contentBytes: 28, contentSha256: "abc" },
          truncatedForContext: true,
        })
        : JSON.stringify({}),
    });

    const serialized = JSON.stringify(messages);
    const calls = messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.id)).toEqual(["append"]);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["append"]);
    expect(serialized).not.toContain("_morrowAppliedWrite");
    expect(messages.find((message) => message.role === "tool" && message.toolCallId === "append")?.content)
      .toContain('"appended":true');
    expect(serialized).not.toContain("append_file completed for src/app.ts");
    expect(serialized).not.toMatch(/requirement is satisfied|do not call append_file again|read-only tool/i);
    expect(serialized).not.toContain("historical record, not a tool request");
  });

  it("bounds a completed large write argument without an executable body or legacy marker", () => {
    const body = "x".repeat(12_000);
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "mission" }],
      turns: [{
        turnKey: "turn-large-append",
        assistantText: "Appended the durable chunk.",
        toolCalls: [{ id: "large-append", name: "append_file", arguments: JSON.stringify({ path: "large.txt", content: body, expectedOffset: 5 }) }],
      }],
      toolResults: [{ id: "large-append", toolName: "append_file", result: JSON.stringify({ status: "success", appendedBytes: body.length, totalBytes: body.length + 5 }), status: "completed" }],
    });

    const call = messages.flatMap((message) => message.toolCalls ?? []).find((item) => item.id === "large-append");
    expect(call).toBeDefined();
    const args = JSON.parse(call!.function.arguments) as Record<string, any>;
    expect(args.path).toBe("large.txt");
    expect(args.expectedOffset).toBe(5);
    expect(args).not.toHaveProperty("content");
    expect(args.durable_context).toMatchObject({ kind: "completed_tool_arguments", tool: "append_file", payloadBytes: body.length });
    expect(JSON.stringify(messages)).not.toContain(body);
    expect(JSON.stringify(messages)).not.toContain("_morrowAppliedWrite");
    expect(messages.filter((message) => message.role === "tool" && message.toolCallId === "large-append")).toHaveLength(1);
  });

  it("bounds oversized failed terminal arguments and results without hiding failure metadata", () => {
    const body = "failed-write-body-" + "x".repeat(12_000);
    const failure = JSON.stringify({
      error: "patch rejected",
      kind: "invalid_tool_arguments",
      detail: "the requested file was not found",
      output: "failure-output-" + "y".repeat(16_000),
    });
    const messages = providerProjectionModule.buildProviderProjection({
      prefixMessages: [{ role: "user", content: "Repair the failed write." }],
      turns: [{
        turnKey: "failed-large-turn",
        assistantText: "The write failed.",
        toolCalls: [{ id: "failed-large", name: "create_file", arguments: JSON.stringify({ path: "missing.txt", content: body }) }],
      }],
      toolResults: [{ id: "failed-large", toolName: "create_file", result: failure, status: "failed" }],
    });
    const assistantCall = messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.id === "failed-large");
    const toolResult = messages.find((message) => message.role === "tool" && message.toolCallId === "failed-large");
    expect(assistantCall).toBeDefined();
    expect(assistantCall!.function.arguments.length).toBeLessThan(8 * 1024);
    expect(JSON.parse(assistantCall!.function.arguments)).toMatchObject({
      path: "missing.txt",
      durable_context: { tool: "create_file", originalBytes: expect.any(Number) },
    });
    expect(toolResult?.content.length).toBeLessThan(8 * 1024);
    expect(toolResult?.content).toContain("invalid_tool_arguments");
    expect(JSON.stringify(messages)).not.toContain(body);
    expect(JSON.stringify(messages)).not.toContain("failure-output-" + "y".repeat(8_000));
    expect(JSON.stringify(messages)).not.toContain("_morrowAppliedWrite");
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

  it("retains the user query when compaction keeps the latest assistant tool batch", () => {
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "tokenrouter",
        model: "qwen/qwen3.8-max-free",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "Execution kernel rules" },
          { role: "user", content: "Build the requested page." },
          { role: "assistant", content: "I will inspect the workspace.", toolCalls: [{ id: "call-1", type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { role: "tool", toolCallId: "call-1", name: "inspect_workspace", content: "workspace facts" },
        ],
        tools: [],
        outputReserveTokens: 16_384,
      },
      resolution,
      forceCompaction: true,
      recentRawGroups: 1,
    });

    expect(result.compacted).toBe(true);
    expect(result.admission.ok).toBe(true);
    expect(result.envelope.messages.some((message) => message.role === "user" && message.content === "Build the requested page.")).toBe(true);
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

  it("uses the canonical model-visible hash instead of private continuation bytes", () => {
    const baseEnvelope = {
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      protocol: "openai-chat" as const,
      route: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        protocol: "openai-chat" as const,
        endpointHost: "api.deepseek.com",
        endpointIdentityHash: "endpoint",
        routeFingerprint: "route-a",
      },
      messages: [{ role: "user" as const, content: "continue", providerContinuation: { reasoningContent: "private-a" } }],
      tools: [],
      outputReserveTokens: 1024,
    };
    const first = projectProviderRequest({ checkpoint: snapshot, envelope: baseEnvelope, resolution, thresholdRatio: 1 });
    const second = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        ...baseEnvelope,
        messages: [{ role: "user" as const, content: "continue", providerContinuation: { reasoningContent: "private-b" } }],
      },
      resolution,
      thresholdRatio: 1,
    });
    expect(first.contentHash).toBe(second.contentHash);
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

  it("leaves headroom below the compaction threshold after projecting a large recent batch", () => {
    const result = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "old context ".repeat(40_000) },
          { role: "assistant", content: "Inspect the generated page", toolCalls: [{ id: "read-large", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "index.html" }) } }] },
          { role: "tool", name: "read_file", toolCallId: "read-large", content: "generated page contents ".repeat(14_000) },
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
    expect(result.admission.measurement.inputTokens).toBeLessThan(knownCapacity(result.thresholdTokens, "thresholdTokens"));
    expect(result.envelope.messages.map((message) => message.content).join("\n")).toContain("latest completed execution batch");

    const nextTurn = projectProviderRequest({
      checkpoint: snapshot,
      envelope: { ...result.envelope, messages: [...result.envelope.messages, { role: "user", content: "Continue with the next required action." }] },
      resolution,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });
    expect(nextTurn.compacted).toBe(false);
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
