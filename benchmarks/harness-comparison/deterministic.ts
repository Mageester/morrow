/**
 * Deterministic head-to-head harness comparison.
 *
 * Both Morrow and pi receive the same tasks and the same scripted model
 * decisions. The local model never uses a network or credentials; it emits
 * equivalent read/write calls using each harness's native tool names. This
 * isolates harness input overhead, turns, tool calls, and local wall time. It
 * does not measure model intelligence.
 *
 * Run:
 *   PI_BINARY=$(command -v pi) pnpm --filter @morrow/orchestrator exec tsx \
 *     ../../benchmarks/harness-comparison/deterministic.ts --repeats 3
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { executeAgentChatTask } from "../../services/orchestrator/src/execution/agent.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolDefinition } from "../../services/orchestrator/src/provider/base.js";
import { conversationsRepository } from "../../services/orchestrator/src/repositories/conversations.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { taskRecordsRepository } from "../../services/orchestrator/src/repositories/task-records.js";
import { taskRepository } from "../../services/orchestrator/src/repositories/tasks.js";
import { taskRoutingRepository } from "../../services/orchestrator/src/repositories/task-routing.js";
import { DEEPSEEK_V4_FLASH_PRICING } from "../harness-economics/metrics.js";
import { projectMorrowUsage } from "./morrow-adapter.js";
import { projectPiUsage } from "./pi-adapter.js";

type Action =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string };

interface DeterministicTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  actions: Action[];
  expected: Record<string, string>;
}

const TASKS: DeterministicTask[] = [
  {
    id: "create-and-verify",
    prompt: "Create result.txt containing exactly `deterministic result` and verify the saved file.",
    files: {},
    actions: [
      { kind: "write", path: "result.txt", content: "deterministic result\n" },
      { kind: "read", path: "result.txt" },
    ],
    expected: { "result.txt": "deterministic result\n" },
  },
  {
    id: "read-transform-verify",
    prompt: "Read input.txt, write its uppercase value to output.txt, then verify output.txt.",
    files: { "input.txt": "quiet harness\n" },
    actions: [
      { kind: "read", path: "input.txt" },
      { kind: "write", path: "output.txt", content: "QUIET HARNESS\n" },
      { kind: "read", path: "output.txt" },
    ],
    expected: { "output.txt": "QUIET HARNESS\n" },
  },
  {
    id: "two-artifacts-verify",
    prompt: "Create alpha.txt with `alpha` and beta.txt with `beta`, then verify both files.",
    files: {},
    actions: [
      { kind: "write", path: "alpha.txt", content: "alpha\n" },
      { kind: "write", path: "beta.txt", content: "beta\n" },
      { kind: "read", path: "alpha.txt" },
      { kind: "read", path: "beta.txt" },
    ],
    expected: { "alpha.txt": "alpha\n", "beta.txt": "beta\n" },
  },
];

interface Result {
  harness: "morrow" | "morrow-broad" | "pi";
  taskId: string;
  passed: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  providerCalls: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function approximateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function modelTool(action: Action, tools: ToolDefinition[] | undefined): { name: string; arguments: Record<string, unknown> } {
  const names = new Set((tools ?? []).map((tool) => tool.name));
  if (action.kind === "read") {
    const name = names.has("read_file") ? "read_file" : "read";
    return { name, arguments: { path: action.path } };
  }
  const name = names.has("create_file") ? "create_file" : "write";
  return { name, arguments: { path: action.path, content: action.content } };
}

class ScriptedProvider implements AiProvider {
  private turn = 0;
  constructor(private readonly actions: Action[]) {}
  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const promptTokens = approximateTokens({ messages, tools: options.tools ?? [] });
    const action = this.actions[this.turn++];
    if (action) {
      const tool = modelTool(action, options.tools);
      const call = { id: `scripted-${this.turn}`, index: 0, type: "function" as const, function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } };
      yield { type: "tool_call", toolCalls: [call] };
      yield { type: "done", finishReason: "tool_calls", usage: { promptTokens, completionTokens: approximateTokens(call), cachedPromptTokens: 0 } };
      return;
    }
    const text = "Task complete and verified.";
    yield { type: "text", text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens, completionTokens: approximateTokens(text), cachedPromptTokens: 0 } };
  }
}

function writeFixture(workspace: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(workspace, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

function verify(workspace: string, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([relative, content]) => {
    try { return readFileSync(join(workspace, relative), "utf8") === content; }
    catch { return false; }
  });
}

function cost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * DEEPSEEK_V4_FLASH_PRICING.inputUsdPerMillion
    + outputTokens * DEEPSEEK_V4_FLASH_PRICING.outputUsdPerMillion) / 1_000_000;
}

async function runMorrow(task: DeterministicTask, broadProfile = false): Promise<Result> {
  const workspace = mkdtempSync(join(tmpdir(), `morrow-deterministic-${task.id}-`));
  const home = mkdtempSync(join(tmpdir(), `morrow-deterministic-home-${task.id}-`));
  const previousHome = process.env.MORROW_HOME;
  const previousAblations = process.env.MORROW_ABLATE;
  process.env.MORROW_HOME = home;
  if (broadProfile) {
    process.env.MORROW_ABLATE = [previousAblations, "focused-tool-profile"].filter(Boolean).join(",");
  }
  writeFixture(workspace, task.files);
  const db = openDatabase(":memory:");
  const started = performance.now();
  let error: string | null = null;
  try {
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: task.id, workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: task.id, createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: task.prompt, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId: "t", presetId: "balanced", providerId: "mock", model: "scripted", useMemory: false,
      decision: {
        version: 1, presetId: "balanced", providerId: "mock", model: "scripted", reason: "deterministic comparison",
        fallbackUsed: false, overridden: true, privacy: "local-only", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
      },
      createdAt: now,
    });
    await executeAgentChatTask({ db, taskId: "t", provider: new ScriptedProvider(task.actions), maxTurns: task.actions.length + 2 });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const events = taskRecordsRepository(db).listEvents("t") as Array<{ type: string; payload: Record<string, unknown> }>;
  const usage = projectMorrowUsage(events);
  const toolCalls = conversationsRepository(db).listToolCallsForTask("t").length;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const result: Result = {
    harness: broadProfile ? "morrow-broad" : "morrow", taskId: task.id, passed: error === null && verify(workspace, task.expected),
    durationMs: performance.now() - started, inputTokens, outputTokens,
    providerCalls: usage.providerCalls, toolCalls, costUsd: cost(inputTokens, outputTokens), error,
  };
  db.close();
  if (previousHome === undefined) delete process.env.MORROW_HOME;
  else process.env.MORROW_HOME = previousHome;
  if (previousAblations === undefined) delete process.env.MORROW_ABLATE;
  else process.env.MORROW_ABLATE = previousAblations;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return result;
}

function sse(response: import("node:http").ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function startScriptedServer(actions: Action[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let turn = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as { messages?: unknown[]; tools?: Array<{ function?: ToolDefinition }> };
      const tools = body.tools?.map((tool) => tool.function).filter((tool): tool is ToolDefinition => Boolean(tool)) ?? [];
      const promptTokens = approximateTokens({ messages: body.messages ?? [], tools: body.tools ?? [] });
      const action = actions[turn++];
      const id = `chatcmpl-${turn}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (action) {
        const tool = modelTool(action, tools);
        const toolCall = { index: 0, id: `scripted-${turn}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } };
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }] });
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: approximateTokens(toolCall), total_tokens: promptTokens + approximateTokens(toolCall), prompt_tokens_details: { cached_tokens: 0 } } });
      } else {
        const text = "Task complete and verified.";
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        sse(response, { id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: approximateTokens(text), total_tokens: promptTokens + approximateTokens(text), prompt_tokens_details: { cached_tokens: 0 } } });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolveClose, reject) => server.close((serverError) => serverError ? reject(serverError) : resolveClose())),
  };
}

async function runPi(task: DeterministicTask, binary: string): Promise<Result> {
  const workspace = mkdtempSync(join(tmpdir(), `pi-deterministic-${task.id}-`));
  const agentDir = mkdtempSync(join(tmpdir(), `pi-deterministic-agent-${task.id}-`));
  writeFixture(workspace, task.files);
  const scripted = await startScriptedServer(task.actions);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "morrow-benchmark": {
        baseUrl: scripted.baseUrl,
        api: "openai-completions",
        apiKey: "local-benchmark",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: "scripted", reasoning: false, contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
        }],
      },
    },
  }, null, 2));
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(binary, [
        "-p", "--mode", "json", "--no-session", "-na", "-nc", "--offline",
        "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--provider", "morrow-benchmark", "--model", "scripted", task.prompt,
      ], {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
          PI_TELEMETRY: "0",
        },
      });
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
  } finally {
    await scripted.close();
  }
  const usage = projectPiUsage(stdout);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const error = exitCode === 0 ? null : `pi exited ${exitCode}: ${stderr.trim().split("\n").slice(-2).join(" | ")}`;
  const result: Result = {
    harness: "pi", taskId: task.id, passed: error === null && verify(workspace, task.expected),
    durationMs: performance.now() - started, inputTokens, outputTokens,
    providerCalls: usage.providerCalls ?? 0, toolCalls: usage.toolCalls ?? 0,
    costUsd: cost(inputTokens, outputTokens), error,
  };
  rmSync(workspace, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  const binary = process.env.PI_BINARY || "pi";
  const repeats = Number(flag("repeats") ?? 3);
  const results: Result[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of TASKS) {
      for (const harness of ["morrow-broad", "morrow", "pi"] as const) {
        const result = harness === "morrow-broad"
          ? await runMorrow(task, true)
          : harness === "morrow"
            ? await runMorrow(task)
            : await runPi(task, binary);
        results.push(result);
        console.log(`${harness.padEnd(6)} ${task.id.padEnd(24)} ${result.passed ? "PASS" : "FAIL"} ${result.durationMs.toFixed(1)}ms ${result.inputTokens} input ${result.toolCalls} tools${result.error ? ` — ${result.error}` : ""}`);
      }
    }
  }

  console.log("\nHarness  Pass       Median input  Median wall  Median tools  Median cost/task");
  for (const harness of ["morrow-broad", "morrow", "pi"] as const) {
    const rows = results.filter((row) => row.harness === harness);
    const passed = rows.filter((row) => row.passed).length;
    console.log(
      `${harness.padEnd(8)} ${`${passed}/${rows.length}`.padEnd(10)} ${String(median(rows.map((row) => row.inputTokens))).padStart(12)}  ` +
      `${`${median(rows.map((row) => row.durationMs)).toFixed(1)}ms`.padStart(11)}  ${String(median(rows.map((row) => row.toolCalls))).padStart(12)}  ` +
      `$${median(rows.map((row) => row.costUsd)).toFixed(6)}`,
    );
  }

  const out = flag("out");
  if (out) writeFileSync(out, `${JSON.stringify({ schemaVersion: 1, model: "scripted-local", repeats, results }, null, 2)}\n`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
