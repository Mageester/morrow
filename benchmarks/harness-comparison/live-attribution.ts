import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@morrow/contracts";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { executeAgentChatTask } from "../../services/orchestrator/src/execution/agent.js";
import { createProvider } from "../../services/orchestrator/src/provider/registry.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../../services/orchestrator/src/provider/base.js";
import { conversationsRepository } from "../../services/orchestrator/src/repositories/conversations.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { taskRepository } from "../../services/orchestrator/src/repositories/tasks.js";
import { taskRoutingRepository } from "../../services/orchestrator/src/repositories/task-routing.js";
import { taskRecordsRepository } from "../../services/orchestrator/src/repositories/task-records.js";
import { writeFixture } from "./fixture.js";
import { TASKS, type EvalTask } from "./tasks.js";

/**
 * Where do Morrow's input tokens actually go, on a real run?
 *
 * The comparison established that Morrow spends roughly 2.3x pi's input tokens
 * per task, and `prefix-stability.ts` ruled out the cheap explanation — nothing
 * is being re-sent because the prefix broke. But that probe scripts its own tool
 * calls, and its appended content is far smaller than a live run's, so it could
 * not say where the live tokens go. This can: it wraps the *real* provider and
 * records every request Morrow actually sends.
 *
 * The unit that matters is **billed bytes**, not bytes. Every request re-sends
 * the whole conversation, so content added on turn 1 of a six-turn run is paid
 * for six times. A category's share of the bill is therefore its size times the
 * number of requests it appears in — which is why a large fixed preamble can
 * cost more than a much larger thing appended near the end.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx \
 *     ../../benchmarks/harness-comparison/live-attribution.ts --tasks a,b,c
 */

interface RequestRecord {
  schemaChars: number;
  messages: Array<{ category: string; chars: number }>;
}

class RecordingProvider implements AiProvider {
  readonly requests: RequestRecord[] = [];
  constructor(private inner: AiProvider) {}

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.requests.push({
      schemaChars: JSON.stringify(options.tools ?? []).length,
      messages: messages.map((message) => ({ category: categorize(message), chars: JSON.stringify(message).length })),
    });
    yield* this.inner.streamChat(messages, options);
  }
}

/**
 * Name each message by what it is, so the report says "inspect_workspace
 * results" rather than "3% other". Tool results are attributed to the tool that
 * produced them, because "read_file is expensive" and "our workspace discovery
 * blob is expensive" are different problems with different fixes.
 */
function categorize(message: ChatMessage): string {
  const record = message as unknown as { role?: string; name?: string; toolCalls?: unknown[] };
  if (record.role === "tool") return `tool result: ${record.name ?? "unknown"}`;
  if (record.role === "system") return "system prompt";
  if (record.role === "user") return "user message";
  if (record.role === "assistant") return Array.isArray(record.toolCalls) && record.toolCalls.length > 0 ? "assistant tool call" : "assistant text";
  return `other: ${record.role ?? "unknown"}`;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function runTask(task: EvalTask, model: string, providerId: ProviderId): Promise<RequestRecord[]> {
  const workspace = mkdtempSync(join(tmpdir(), `attrib-${task.id}-`));
  const home = mkdtempSync(join(tmpdir(), `attrib-home-${task.id}-`));
  const previousHome = process.env.MORROW_HOME;
  process.env.MORROW_HOME = home;
  writeFixture(workspace, task.files);

  const recording = new RecordingProvider(createProvider(providerId, process.env, model));
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: `Attribution ${task.id}`, workspacePath: workspace, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: task.id, createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: task.prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId, model, useMemory: true,
    decision: {
      version: 1, presetId: "best-quality", providerId, model, reason: "live attribution",
      fallbackUsed: false, overridden: true, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
    },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });

  try {
    await executeAgentChatTask({ db, taskId: "t", provider: recording, abortSignal: AbortSignal.timeout(8 * 60 * 1000) });
  } catch (error) {
    console.error(`  ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = previousHome;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  return recording.requests;
}

async function main(): Promise<void> {
  const model = flag("model") ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const providerId = (flag("provider") ?? "deepseek") as ProviderId;
  const selected = flag("tasks")?.split(",").map((id) => id.trim()).filter(Boolean);
  const tasks = selected ? TASKS.filter((task) => selected.includes(task.id)) : TASKS.slice(0, 5);

  const billed = new Map<string, number>();
  const distinct = new Map<string, number>();
  let totalBilled = 0;
  let requestCount = 0;
  const perTask: Array<{ id: string; requests: number; billedChars: number }> = [];

  for (const task of tasks) {
    process.stdout.write(`${task.id} … `);
    const requests = await runTask(task, model, providerId);
    let taskBilled = 0;
    for (const request of requests) {
      requestCount++;
      // Schemas ride in front of every request, so they are billed once per
      // request just like the messages are.
      billed.set("tool schemas", (billed.get("tool schemas") ?? 0) + request.schemaChars);
      totalBilled += request.schemaChars;
      taskBilled += request.schemaChars;
      for (const message of request.messages) {
        billed.set(message.category, (billed.get(message.category) ?? 0) + message.chars);
        totalBilled += message.chars;
        taskBilled += message.chars;
      }
    }
    // Distinct size: what the final request carried, i.e. each thing counted once.
    const last = requests[requests.length - 1];
    if (last) {
      distinct.set("tool schemas", (distinct.get("tool schemas") ?? 0) + last.schemaChars);
      for (const message of last.messages) {
        distinct.set(message.category, (distinct.get(message.category) ?? 0) + message.chars);
      }
    }
    perTask.push({ id: task.id, requests: requests.length, billedChars: taskBilled });
    console.log(`${requests.length} request(s), ${taskBilled} billed chars`);
  }

  console.log(`\n${tasks.length} task(s), ${requestCount} provider request(s), ${totalBilled} billed chars total.\n`);
  console.log("Where the input bill goes (billed = size x how many requests carried it):\n");
  console.log(`${"category".padEnd(34)} ${"billed".padStart(10)} ${"share".padStart(7)}  ${"distinct".padStart(9)} ${"amplification".padStart(13)}`);
  const rows = [...billed.entries()].sort((a, b) => b[1] - a[1]);
  for (const [category, chars] of rows) {
    const once = distinct.get(category) ?? 0;
    const amplification = once > 0 ? `${(chars / once).toFixed(1)}x` : "—";
    console.log(
      `${category.padEnd(34)} ${String(chars).padStart(10)} ${((chars / totalBilled) * 100).toFixed(1).padStart(6)}%  ${String(once).padStart(9)} ${amplification.padStart(13)}`,
    );
  }

  const out = flag("out");
  if (out) {
    writeFileSync(out, `${JSON.stringify({ model, tasks: perTask, billed: Object.fromEntries(rows), distinct: Object.fromEntries(distinct), totalBilled, requestCount }, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
