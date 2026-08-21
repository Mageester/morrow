/**
 * Deterministic micro-benchmark for the per-turn hot paths: token accounting,
 * canonical request projection, context trimming, and durable event writes.
 *
 * Run: pnpm --filter @morrow/orchestrator exec tsx benchmark/hot-paths.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ToolDefinition } from "../src/provider/base.js";
import { measureProviderRequest, trimMessagesToBudget, countChatTokens } from "../src/execution/context-budget.js";
import { projectProviderRequest } from "../src/execution/provider-projection.js";
import { buildCanonicalProviderRequest } from "../src/execution/canonical-request.js";
import { openDatabase } from "../src/database.js";
import { redactSecrets, redactSecretsExhaustive } from "../src/provider/credentials.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

function bench(name: string, iterations: number, fn: () => void): void {
  fn();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${name.padEnd(46)} ${(elapsedMs / iterations).toFixed(3).padStart(10)} ms/op  (${iterations} ops)`);
}

function buildMessages(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "You are Morrow. ".repeat(200) }];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: `Fix defect ${turn} in the cart totals. ${"context ".repeat(40)}` });
    messages.push({
      role: "assistant",
      content: `Reading the cart module for defect ${turn}.`,
      toolCalls: [{ id: `call-${turn}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/module-${turn}.ts` }) } }],
    });
    messages.push({ role: "tool", name: "read_file", toolCallId: `call-${turn}`, content: `export function module${turn}() {\n${"  // body line\n".repeat(60)}}` });
  }
  return messages;
}

function buildTools(count: number): ToolDefinition[] {
  return Array.from({ length: count }, (_value, index) => ({
    name: `tool_${index}`,
    description: `Deterministic benchmark tool ${index}. ${"Describes the tool behaviour. ".repeat(6)}`,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        content: { type: "string", description: "Payload to write." },
        purpose: { type: "string", description: "Why this call is being made." },
      },
      required: ["path"],
    },
  }));
}

const messages = buildMessages(120);
const tools = buildTools(24);
const envelope = { providerId: "openai", model: "gpt-5", protocol: "openai-chat" as const, messages, tools, outputReserveTokens: 4096 };

const route = { providerId: "openai", modelId: "gpt-5", protocol: "openai-chat" as const, endpointHost: null, endpointIdentityHash: null, routeFingerprint: "bench" };

console.log(`context: ${messages.length} messages, ${tools.length} tools\n`);

bench("countChatTokens (estimate route)", 20, () => { countChatTokens(messages, { providerId: "anthropic", model: "claude" }); });
bench("countChatTokens (exact tiktoken route)", 20, () => { countChatTokens(messages, { providerId: "openai", model: "gpt-5" }); });
bench("measureProviderRequest", 20, () => { measureProviderRequest(envelope); });
bench("trimMessagesToBudget", 20, () => { trimMessagesToBudget(messages, { maxInputTokens: 8000 }); });

const checkpoint = {
  version: 1 as const,
  originalMission: "Fix the cart totals and receipt rounding.",
  hardRequirements: ["Tests must pass"], prohibitedActions: [], acceptanceCriteria: ["node --test is green"],
  decisions: ["Tax is applied per line item"], completedWork: ["Read src/cart.mjs"], currentPhase: "implementing",
  filesChanged: ["src/cart.mjs"], gitStatus: " M src/cart.mjs\n M src/receipt.mjs",
  tests: [{ command: "node --test", exitCode: 1, result: "2 failing" }],
  unresolvedFailures: ["receipt rounding"], recoveryAttempts: [], pendingWork: ["fix receipt"],
  approvals: {}, taskId: "task-bench", missionId: null, providerRouting: {}, providerContinuationRefs: [], evidenceRequired: [],
};
bench("buildCanonicalProviderRequest", 20, () => {
  buildCanonicalProviderRequest({ route: route, messages, tools, outputReserveTokens: 4096 });
});
bench("projectProviderRequest (compaction path)", 20, () => {
  projectProviderRequest({ checkpoint, envelope, resolution: { usableInputTokens: 16000 } as any, forceCompaction: true });
});
bench("projectProviderRequest (fast path)", 20, () => {
  projectProviderRequest({ checkpoint, envelope, resolution: { usableInputTokens: 5_000_000 } as any });
});

const sourceBlob = `export function cart(items) {\n${"  const line = items[i].price * items[i].quantity;\n".repeat(4000)}}`;
const jsonBlob = JSON.stringify({ files: Array.from({ length: 2000 }, (_v, i) => ({ path: `src/file-${i}.ts`, bytes: i * 37, status: "modified" })) });
console.log(`\nredaction inputs: source ${(sourceBlob.length / 1024).toFixed(0)} KB, json ${(jsonBlob.length / 1024).toFixed(0)} KB`);
bench("redactSecrets  source blob (guarded)", 50, () => { redactSecrets(sourceBlob); });
bench("redactSecrets  source blob (unguarded)", 50, () => { redactSecretsExhaustive(sourceBlob); });
bench("redactSecrets  json blob (guarded)", 50, () => { redactSecrets(jsonBlob); });
bench("redactSecrets  json blob (unguarded)", 50, () => { redactSecretsExhaustive(jsonBlob); });

const directory = mkdtempSync(join(tmpdir(), "morrow-bench-"));
const db = openDatabase(join(directory, "bench.db"));
try {
  const records = taskRecordsRepository(db);
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p1", name: "bench", workspacePath: directory, createdAt: now } as any);
  taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "chat", status: "queued", createdAt: now } as any);
  const taskId = "t1";
  let sequence = 0;
  bench("records.appendEvent (durable write)", 2000, () => {
    records.appendEvent({ id: `event-${sequence++}`, taskId, type: "agent.state_changed", payload: { state: "thinking", n: sequence }, createdAt: new Date().toISOString() });
  });

  // One streamed assistant response, persisted the way the agent persists it.
  // `chunks` stands in for provider tokens; `flushEvery` is how many of them
  // share a single durable write.
  const convs = conversationsRepository(db);
  convs.createConversation({ id: "c1", projectId: "p1", title: "bench", createdAt: now, updatedAt: now });
  const chunkText = "the quick brown fox jumps ";
  let messageSequence = 0;
  const streamedResponse = (label: string, chunks: number, flushEvery: number) => {
    bench(label, 3, () => {
      const messageId = `m-${messageSequence++}`;
      convs.appendMessage({ id: messageId, conversationId: "c1", role: "assistant", content: "", taskId, streamingState: "streaming", createdAt: now, updatedAt: now });
      let content = "";
      let pending = "";
      for (let index = 0; index < chunks; index++) {
        content += chunkText;
        pending += chunkText;
        if ((index + 1) % flushEvery === 0 || index === chunks - 1) {
          convs.updateMessageContentAndState(messageId, content, "streaming", now);
          records.appendEvent({ id: `delta-${messageSequence}-${index}`, taskId, type: "evidence.persisted", payload: { deltaText: pending, turnId: "turn-1" }, createdAt: now });
          pending = "";
        }
      }
    });
  };
  console.log("");
  streamedResponse("stream 2000 chunks, write per chunk", 2000, 1);
  streamedResponse("stream 2000 chunks, coalesced 1:25", 2000, 25);
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
