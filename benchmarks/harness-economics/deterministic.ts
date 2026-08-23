#!/usr/bin/env tsx

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { executeAgentChatTask } from "../../services/orchestrator/src/execution/agent.js";
import { measureProviderRequest, type ProviderRequestMeasurement } from "../../services/orchestrator/src/execution/context-budget.js";
import { projectFlagshipEfficiency } from "../../services/orchestrator/src/acceptance/flagship-runner.js";
import { OpenAiCompatibleProvider } from "../../services/orchestrator/src/provider/openai-compatible.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolCall } from "../../services/orchestrator/src/provider/base.js";
import { translateReasoning } from "../../services/orchestrator/src/provider/reasoning.js";
import { conversationsRepository } from "../../services/orchestrator/src/repositories/conversations.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { taskRecordsRepository } from "../../services/orchestrator/src/repositories/task-records.js";
import { taskRepository } from "../../services/orchestrator/src/repositories/tasks.js";
import { taskRoutingRepository } from "../../services/orchestrator/src/repositories/task-routing.js";
import { DEEPSEEK_V4_FLASH_PRICING, renderBenchmarkSvg, summarizeBenchmarkRecords, type BenchmarkRecord, type TokenPricing } from "./metrics.js";

const EVIDENCE_CLASS = "deterministic-local" as const;
const BENCHMARK_RUN = "corrected-fixture-2026-08-11";
const MODEL = "deepseek-v4-flash";
const PROVIDER = "deepseek";
const PRESET = "balanced";
const FIXED_NOW = "2026-08-11T00:00:00.000Z";
const OUTPUT_TOKENS = 12;
const ROOT_BENCHMARK_DIR = resolve(process.cwd(), "benchmarks", "harness-economics");
const BENCHMARK_DIR = existsSync(ROOT_BENCHMARK_DIR)
  ? ROOT_BENCHMARK_DIR
  : resolve(process.cwd(), "..", "..", "benchmarks", "harness-economics");
const RESULTS_DIR = resolve(BENCHMARK_DIR, "results");

type ReasoningMode = "off" | "low" | "high";

interface RequestTrace {
  measurement: ProviderRequestMeasurement;
  options: StreamOptions;
  timeToFirstTokenMs: number | null;
  completionMs: number | null;
}

interface Verification {
  passed: boolean;
  failureReason: string | null;
}

interface ProviderBundle {
  primary: AiProvider;
  fallbacks: AiProvider[];
  traces: ScriptedProvider[];
}

interface Scenario {
  id: string;
  prompt: string;
  model?: string;
  providerId?: string;
  historyMessages?: number;
  initializeWorkspace?: (workspace: string) => void;
  turns?: ProviderChunk[][];
  reasoning?: { mode: "off" } | { mode: "effort"; effort: "low" | "high" };
  providerFactory?: () => ProviderBundle;
  pricing?: TokenPricing | null;
  verify: (workspace: string, status: string | null, answer: string) => Verification;
}

function tool(id: string, name: string, args: unknown, index = 0): ProviderChunk {
  const call: ToolCall = {
    id,
    index,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  return { type: "tool_call", toolCalls: [call] };
}

function batchTools(calls: Array<{ id: string; name: string; args: unknown }>): ProviderChunk {
  return {
    type: "tool_call",
    toolCalls: calls.map((call, index) => ({
      id: call.id,
      index,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

const done: ProviderChunk = { type: "done", finishReason: "stop" };
const answer = (text: string): ProviderChunk[] => [{ type: "text", text }, done];

/** A local provider that replays a fixed model transcript and reports the
 * exact request envelope Morrow handed it. It never opens a network socket. */
class ScriptedProvider implements AiProvider {
  readonly id: string;
  readonly traces: RequestTrace[] = [];
  private turn = 0;

  constructor(
    id: string,
    private readonly turns: ProviderChunk[][],
    private readonly outputTokens = OUTPUT_TOKENS,
  ) {
    this.id = id;
  }

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const model = options.model ?? MODEL;
    const measurement = measureProviderRequest({
      providerId: this.id,
      model,
      protocol: "openai-chat",
      messages,
      tools: options.tools ?? [],
      outputReserveTokens: options.maxOutputTokens ?? 0,
    });
    const trace: RequestTrace = { measurement, options, timeToFirstTokenMs: null, completionMs: null };
    this.traces.push(trace);
    const current = this.turn++;
    const startedAt = performance.now();
    try {
      for (const chunk of this.turns[current] ?? answer("The scripted task is complete.")) {
        trace.timeToFirstTokenMs ??= Math.max(0, performance.now() - startedAt);
        if (chunk.type !== "done" || chunk.usage) {
          yield chunk;
          continue;
        }
        yield {
          ...chunk,
          usage: {
            promptTokens: measurement.inputTokens,
            completionTokens: this.outputTokens,
            cachedPromptTokens: current === 0 ? 0 : Math.floor(measurement.inputTokens / 2),
          },
        };
      }
    } finally {
      trace.completionMs = Math.max(0, performance.now() - startedAt);
    }
  }
}

class ThrowingProvider implements AiProvider {
  readonly id: string;
  constructor(id: string, private readonly message: string) {
    this.id = id;
  }

  async *streamChat(): AsyncIterable<ProviderChunk> {
    throw new Error(this.message);
  }
}

function seedTask(db: ReturnType<typeof openDatabase>, workspace: string, scenario: Scenario, taskId: string): void {
  const providerId = scenario.providerId ?? PROVIDER;
  const model = scenario.model ?? MODEL;
  projectRepository(db).createProject({ id: "benchmark-project", name: "Harness economics", workspacePath: workspace, createdAt: FIXED_NOW });
  conversationsRepository(db).createConversation({ id: "benchmark-conversation", projectId: "benchmark-project", title: scenario.id, createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
  for (let index = 0; index < (scenario.historyMessages ?? 0); index += 1) {
    const body = `Historical fixture ${index}: ${"context-token ".repeat(500)}`;
    conversationsRepository(db).appendMessage({ id: `history-user-${index}`, conversationId: "benchmark-conversation", role: "user", content: body, createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
    conversationsRepository(db).appendMessage({ id: `history-assistant-${index}`, conversationId: "benchmark-conversation", role: "assistant", content: `Historical response ${index}: ${"response-token ".repeat(500)}`, createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
  }
  conversationsRepository(db).appendMessage({ id: `user-${taskId}`, conversationId: "benchmark-conversation", role: "user", content: scenario.prompt, createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
  taskRepository(db).createTask({ id: taskId, projectId: "benchmark-project", kind: "agent_chat", status: "queued", createdAt: FIXED_NOW });
  // Conversation ordering is deterministic by (created_at, id); keep the
  // task's assistant row after the seeded history so the runtime reconstructs
  // the same full prompt that a real chronological conversation would have.
  conversationsRepository(db).appendMessage({ id: `zz-assistant-${taskId}`, conversationId: "benchmark-conversation", role: "assistant", content: "", taskId, streamingState: "queued", createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
  taskRoutingRepository(db).upsert({
    taskId,
    presetId: PRESET,
    providerId: providerId as any,
    model,
    useMemory: false,
    decision: {
      version: 1,
      presetId: PRESET,
      providerId,
      model,
      reason: "deterministic harness economics fixture",
      fallbackUsed: false,
      overridden: true,
      privacy: "cloud",
      candidates: [],
      mode: "agent",
      toolProfile: "agent",
      autoApprove: true,
      ...(scenario.reasoning ? { reasoning: scenario.reasoning } : {}),
    },
    createdAt: FIXED_NOW,
  } as any);
}

function completed(status: string | null, answerText: string, expected: string): Verification {
  return status === "completed" && answerText.includes(expected)
    ? { passed: true, failureReason: null }
    : { passed: false, failureReason: "task_or_answer_contract" };
}

function fileContains(workspace: string, path: string, expected: string, status: string | null, answerText: string): Verification {
  try {
    return status === "completed" && readFileSync(join(workspace, path), "utf8").includes(expected)
      ? { passed: true, failureReason: null }
      : { passed: false, failureReason: "artifact_contract" };
  } catch {
    return { passed: false, failureReason: "artifact_missing" };
  }
}

function createScenarios(): Scenario[] {
  return [
    {
      id: "simple-answer",
      prompt: "What is 6 multiplied by 7? Answer briefly.",
      turns: [answer("42")],
      verify: (workspace, status, text) => completed(status, text, "42"),
    },
    {
      id: "read-search-summarize",
      prompt: "Find the marker in the fixture and summarize the implementation file.",
      initializeWorkspace: (workspace) => {
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "fixture marker: efficiency\n", "utf8");
        writeFileSync(join(workspace, "src", "feature.ts"), "export const feature = 'local evidence';\n", "utf8");
      },
      turns: [
        [tool("search", "search_text", { query: "efficiency", path: ".", caseSensitive: false }), done],
        [tool("read", "read_file", { path: "src/feature.ts" }), done],
        answer("The fixture marker is efficiency and feature.ts is local evidence."),
      ],
      verify: (workspace, status, text) => completed(status, text, "local evidence"),
    },
    {
      id: "duplicate-read-dedup",
      prompt: "Search for the marker twice if needed, then report the result.",
      initializeWorkspace: (workspace) => writeFileSync(join(workspace, "README.md"), "fixture marker: dedup\n", "utf8"),
      turns: [
        [tool("search-a", "search_text", { query: "dedup", path: ".", caseSensitive: false }), done],
        [tool("search-b", "search_text", { caseSensitive: false, path: ".", query: "dedup" }), done],
        answer("The marker is dedup."),
      ],
      verify: (workspace, status, text) => completed(status, text, "dedup"),
    },
    {
      id: "multi-file-edit",
      prompt: "Create both fixture files with the requested contents, then confirm them.",
      initializeWorkspace: (workspace) => mkdirSync(join(workspace, "src"), { recursive: true }),
      turns: [
        [batchTools([
          { id: "one", name: "create_file", args: { path: "src/one.txt", content: "one\n" } },
          { id: "two", name: "create_file", args: { path: "src/two.txt", content: "two\n" } },
        ]), done],
        [batchTools([
          { id: "read-one", name: "read_file", args: { path: "src/one.txt" } },
          { id: "read-two", name: "read_file", args: { path: "src/two.txt" } },
        ]), done],
        answer("Both files are present."),
      ],
      verify: (workspace, status) => status === "completed"
        && readFileSync(join(workspace, "src/one.txt"), "utf8") === "one\n"
        && readFileSync(join(workspace, "src/two.txt"), "utf8") === "two\n"
        ? { passed: true, failureReason: null }
        : { passed: false, failureReason: "artifact_contract" },
    },
    {
      id: "new-file-creation",
      prompt: "Create a new file and verify its contents before reporting completion.",
      turns: [
        [tool("write", "create_file", { path: "created.txt", content: "created by fixture\n" }), done],
        [tool("verify", "read_file", { path: "created.txt" }), done],
        answer("created.txt was verified."),
      ],
      verify: (workspace, status, text) => fileContains(workspace, "created.txt", "created by fixture", status, text),
    },
    {
      id: "file-write-failure-retry",
      prompt: "Create retry.txt, recover from any write validation error, verify it, and finish.",
      turns: [
        [tool("bad-write", "create_file", { path: "retry.txt" }), done],
        [tool("good-write", "create_file", { path: "retry.txt", content: "recovered write\n" }), done],
        [tool("verify-retry", "read_file", { path: "retry.txt" }), done],
        answer("The failed write was repaired and retry.txt was verified."),
      ],
      verify: (workspace, status, text) => fileContains(workspace, "retry.txt", "recovered write", status, text),
    },
    {
      id: "failed-tool-recovery",
      prompt: "Recover from one failed inspection, read the fixture, and summarize it.",
      initializeWorkspace: (workspace) => writeFileSync(join(workspace, "recovery.txt"), "recovered observation\n", "utf8"),
      turns: [
        [tool("bad-read", "read_file", {}), done],
        [tool("good-read", "read_file", { path: "recovery.txt" }), done],
        answer("Recovered observation: recovered observation."),
      ],
      verify: (workspace, status, text) => completed(status, text, "Recovered observation"),
    },
    {
      id: "long-context",
      prompt: "Use the most recent request and answer with the fixed word: compacted.",
      historyMessages: 160,
      turns: [answer("compacted")],
      verify: (workspace, status, text) => completed(status, text, "compacted"),
    },
    {
      id: "reasoning-off",
      prompt: "Answer with the fixed word: off.",
      reasoning: { mode: "off" },
      turns: [answer("off")],
      verify: (workspace, status, text) => completed(status, text, "off"),
    },
    {
      id: "reasoning-low",
      prompt: "Answer with the fixed word: low.",
      reasoning: { mode: "effort", effort: "low" },
      turns: [answer("low")],
      verify: (workspace, status, text) => completed(status, text, "low"),
    },
    {
      id: "reasoning-high",
      prompt: "Answer with the fixed word: high.",
      reasoning: { mode: "effort", effort: "high" },
      turns: [answer("high")],
      verify: (workspace, status, text) => completed(status, text, "high"),
    },
    {
      id: "mutation-verification-required",
      prompt: "Write a mutation marker, read it back, and only then report completion.",
      turns: [
        [tool("mutation", "create_file", { path: "mutation.txt", content: "verified mutation\n" }), done],
        [tool("mutation-read", "read_file", { path: "mutation.txt" }), done],
        answer("The mutation was verified."),
      ],
      verify: (workspace, status, text) => fileContains(workspace, "mutation.txt", "verified mutation", status, text),
    },
    {
      id: "partial-artifact",
      prompt: "Create the artifact and report completion.",
      turns: [
        [tool("partial", "create_file", { path: "partial.txt", content: "wrong artifact\n" }), done],
        [tool("partial-read", "read_file", { path: "partial.txt" }), done],
        answer("The artifact is complete."),
      ],
      verify: (workspace, status) => status === "completed" && readFileSync(join(workspace, "partial.txt"), "utf8") === "expected artifact\n"
        ? { passed: true, failureReason: null }
        : { passed: false, failureReason: "artifact_contract" },
    },
    {
      id: "provider-fallback-retry",
      prompt: "Answer after the primary route experiences a transient start failure.",
      providerFactory: () => {
        const secondary = new ScriptedProvider("openai", [answer("fallback answer")]);
        return { primary: new ThrowingProvider(PROVIDER, "ECONNREFUSED"), fallbacks: [secondary], traces: [secondary] };
      },
      pricing: null,
      verify: (workspace, status, text) => completed(status, text, "fallback answer"),
    },
    {
      id: "provider-recovery-failure",
      prompt: "Answer even though the provider is unavailable.",
      providerFactory: () => ({ primary: new ThrowingProvider(PROVIDER, "ECONNREFUSED"), fallbacks: [], traces: [] }),
      pricing: DEEPSEEK_V4_FLASH_PRICING,
      verify: (_workspace, status) => status === "failed"
        ? { passed: false, failureReason: "provider_failure" }
        : { passed: false, failureReason: "unexpected_completion" },
    },
  ];
}

function sumUsage(events: Array<{ type: string; payload: Record<string, unknown> }>, field: string): number | null {
  const usage = events.filter((event) => event.type === "provider.usage");
  if (usage.length === 0 || !usage.every((event) => typeof event.payload[field] === "number")) return null;
  return usage.reduce((sum, event) => sum + Number(event.payload[field]), 0);
}

function optionalSumUsage(events: Array<{ type: string; payload: Record<string, unknown> }>, field: string): number | null {
  const usage = events.filter((event) => event.type === "provider.usage");
  if (usage.length === 0 || !usage.some((event) => typeof event.payload[field] === "number")) return null;
  return usage.reduce((sum, event) => sum + (typeof event.payload[field] === "number" ? Number(event.payload[field]) : 0), 0);
}

async function runScenario(scenario: Scenario): Promise<BenchmarkRecord & Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), `morrow-economics-${scenario.id}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(":memory:");
  const taskId = `benchmark-${scenario.id}`;
  const bundle = scenario.providerFactory?.() ?? (() => {
    const scripted = new ScriptedProvider(scenario.providerId ?? PROVIDER, scenario.turns ?? [answer("The scripted task is complete.")]);
    return { primary: scripted, fallbacks: [], traces: [scripted] };
  })();

  try {
    scenario.initializeWorkspace?.(workspace);
    seedTask(db, workspace, scenario, taskId);
    const seededMessageCount = conversationsRepository(db).listMessages("benchmark-conversation").length;
    const started = performance.now();
    await executeAgentChatTask({
      db,
      taskId,
      provider: bundle.primary,
      ...(bundle.fallbacks.length > 0 ? { fallbackProviders: bundle.fallbacks } : {}),
      now: () => FIXED_NOW,
    });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const task = taskRepository(db).getTaskById(taskId);
    const assistant = conversationsRepository(db).getMessage(`zz-assistant-${taskId}`);
    const calls = conversationsRepository(db).listToolCallsForTask(taskId);
    const events = taskRecordsRepository(db).listEvents(taskId) as Array<{ type: string; payload: Record<string, unknown> }>;
    const efficiency = projectFlagshipEfficiency(events);
    const verification = scenario.verify(workspace, task?.status ?? null, assistant?.content ?? "");
    const passed = task?.status === "completed" && verification.passed;
    const outcome = passed ? "success" : task?.status === "completed" ? "partial" : "failure";
    const traces = bundle.traces.flatMap((provider) => provider.traces);
    const requestInputTokens = traces.map((trace) => trace.measurement.inputTokens);
    const firstOutputTrace = traces.find((trace) => trace.timeToFirstTokenMs !== null);
    const timeToFirstTokenMs = firstOutputTrace?.timeToFirstTokenMs ?? null;
    const providerCompletionMs = traces.length > 0
      ? traces.reduce((sum, trace) => sum + (trace.completionMs ?? 0), 0)
      : null;
    const contextTokenSamples = events.flatMap((event) => {
      const candidates = event.type === "context.budget_calculated"
        ? [event.payload.currentRequestTokens]
        : event.type === "context.trimmed" || event.type === "context.compaction_completed"
          ? [event.payload.finalTokens, event.payload.thresholdTokens]
          : [];
      return candidates.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    });
    const contextGrowthTokens = requestInputTokens.length > 1
      ? Math.max(...requestInputTokens) - Math.min(...requestInputTokens)
      : requestInputTokens.length === 1 ? 0 : null;
    const toolSchemaTokens = traces.reduce((sum, trace) => sum + trace.measurement.components.toolSchemas, 0);
    const protocolOverheadTokens = traces.reduce((sum, trace) => sum + trace.measurement.components.protocolOverhead, 0);
    const providerContinuationTokens = traces.reduce((sum, trace) => sum + trace.measurement.components.providerContinuation, 0);
    const harnessOverheadTokens = toolSchemaTokens + protocolOverheadTokens + providerContinuationTokens;
    const reasoningModes = traces
      .map((trace) => trace.options.reasoning?.mode === "effort" ? `${trace.options.reasoning.mode}:${trace.options.reasoning.effort}` : trace.options.reasoning?.mode ?? "auto")
      .filter((mode, index, all) => all.indexOf(mode) === index);

    return {
      harness: "Morrow",
      model: scenario.model ?? MODEL,
      taskId,
      scenario: scenario.id,
      benchmarkRun: BENCHMARK_RUN,
      evidenceClass: EVIDENCE_CLASS,
      outcome,
      failureReason: passed ? null : verification.failureReason,
      reasoningMode: reasoningModes.join(",") || null,
      passed,
      durationMs,
      timeToFirstTokenMs,
      providerCompletionMs,
      inputTokens: sumUsage(events, "totalInputTokens"),
      cachedInputTokens: sumUsage(events, "cachedInputTokens"),
      outputTokens: sumUsage(events, "outputTokens"),
      reasoningTokens: optionalSumUsage(events, "reasoningTokens"),
      requestInputTokens,
      contextTokenSamples,
      contextGrowthTokens,
      harnessOverheadTokens,
      toolSchemaTokens,
      protocolOverheadTokens,
      providerContinuationTokens,
      providerCalls: efficiency.providerCalls,
      toolCalls: calls.length,
      toolFailures: events.filter((event) => event.type === "tool.failed").length,
      fallbackEvents: events.filter((event) => event.type === "provider.fallback").length,
      duplicateObservations: efficiency.duplicateObservations,
      contextCompactions: efficiency.contextCompactions,
      recoveryAttempts: efficiency.recoveryAttempts,
      interventions: efficiency.interventions,
      pricing: scenario.pricing === undefined ? DEEPSEEK_V4_FLASH_PRICING : scenario.pricing,
      measuredCostUsd: null,
      taskStatus: task?.status ?? null,
      answerBytes: Buffer.byteLength(assistant?.content ?? "", "utf8"),
      seededMessageCount,
    };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function sseResponse(): Response {
  const body = [
    `data: {"choices":[{"delta":{"content":"local"},"finish_reason":"stop"}]}\n\n`,
    `data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collectReasoningWireEvidence(): Promise<Array<Record<string, unknown>>> {
  const previousFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse();
  }) as typeof fetch;
  const capability = { control: "effort" as const, efforts: ["low", "high", "xhigh", "max"] as any, budgets: [], source: "provider-metadata" as const, supportsOff: true, wire: "deepseek-thinking" as const };
  const provider = new OpenAiCompatibleProvider({ id: PROVIDER, apiKey: "", baseUrl: "https://local.invalid/v1", defaultModel: MODEL, includeUsage: true });
  try {
    for (const [mode, reasoning] of [
      ["off", { mode: "off" }],
      ["low", { mode: "effort", effort: "low" }],
      ["high", { mode: "effort", effort: "high" }],
    ] as const) {
      const translation = translateReasoning(reasoning as any, "openai-chat", capability);
      const chunks: ProviderChunk[] = [];
      for await (const chunk of provider.streamChat([{ role: "user", content: "Use the fixed local reasoning fixture." }], {
        model: MODEL,
        maxOutputTokens: 64,
        reasoning: reasoning as any,
        reasoningCapability: capability,
      })) chunks.push(chunk);
      const body = bodies[bodies.length - 1] ?? {};
      if (!translation.ok) throw new Error(`Reasoning fixture rejected ${mode}: ${translation.reason}`);
      if (chunks.length === 0 || body.model !== MODEL) throw new Error(`Reasoning fixture did not produce a response for ${mode}`);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
  return bodies.map((body, index) => ({
    scenario: `reasoning-wire-${["off", "low", "high"][index]}`,
    evidenceClass: EVIDENCE_CLASS,
    wireBody: body,
  }));
}

async function main(): Promise<void> {
  const records: Array<BenchmarkRecord & Record<string, unknown>> = [];
  mkdirSync(RESULTS_DIR, { recursive: true });
  const evidencePath = resolve(RESULTS_DIR, "deterministic-evidence.jsonl");
  for (const scenario of createScenarios()) {
    const record = await runScenario(scenario);
    records.push(record);
    appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, "utf8");
    console.log(`${record.scenario}: ${record.outcome} | calls=${record.providerCalls ?? "n/a"} tools=${record.toolCalls ?? "n/a"} input=${record.inputTokens ?? "n/a"} output=${record.outputTokens ?? "n/a"} duration=${record.durationMs}ms`);
  }

  const wireEvidence = await collectReasoningWireEvidence();
  for (const row of wireEvidence) appendFileSync(evidencePath, `${JSON.stringify(row)}\n`, "utf8");

  const reportPath = resolve(RESULTS_DIR, "deterministic-report.svg");
  const summaryPath = resolve(RESULTS_DIR, "deterministic-summary.json");
  writeFileSync(reportPath, renderBenchmarkSvg(summarizeBenchmarkRecords(records), { title: "Morrow deterministic harness economics · 2026-08-11" }), "utf8");
  writeFileSync(summaryPath, JSON.stringify({ evidenceClass: EVIDENCE_CLASS, records, wireEvidence, summaries: summarizeBenchmarkRecords(records) }, null, 2) + "\n", "utf8");
  console.log(`Append-only evidence: ${evidencePath}`);
  console.log(`Derived summary: ${summaryPath}`);
  console.log(`Derived chart: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
