import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { executeAgentChatTask } from "../../services/orchestrator/src/execution/agent.js";
import { MockProvider } from "../../services/orchestrator/src/provider/mock.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../../services/orchestrator/src/provider/base.js";
import { conversationsRepository } from "../../services/orchestrator/src/repositories/conversations.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { taskRecordsRepository } from "../../services/orchestrator/src/repositories/task-records.js";
import { taskRepository } from "../../services/orchestrator/src/repositories/tasks.js";
import { taskRoutingRepository } from "../../services/orchestrator/src/repositories/task-routing.js";
import { writeFixture } from "./fixture.js";
import { taskById } from "./tasks.js";

/**
 * Why is Morrow's uncached input token count so much larger than a bare loop's?
 *
 * Summed token counts cannot answer that, because two different mechanisms
 * produce the same total: a harness can re-send a prompt whose prefix it keeps
 * invalidating, or it can honestly append more new content per turn. On a
 * provider where uncached input costs 50x cached, which one it is decides
 * whether the fix is free or a behaviour change.
 *
 * Prefix stability is a deterministic property of the requests Morrow builds,
 * so it needs no provider at all. This drives a real agent task through
 * `MockProvider`, which records every message array handed to the provider,
 * and measures each request against the standard a prefix cache actually
 * requires: **request N+1 must begin with request N, byte for byte.** Every
 * character short of that is context Morrow already paid for and is paying for
 * again.
 *
 * The comparison is against that append-only ideal rather than against pi
 * directly — pi is a black box that does not expose per-request payloads. The
 * ideal is the right bar regardless: it is what pi meets by construction, and
 * what any harness must meet to be cacheable.
 *
 * Both halves of the request are measured. `MockProvider` records only the
 * message array, and on a first request the tool schemas are several times
 * larger than the messages — a harness whose exposed tool set changes between
 * turns invalidates its cache at position zero, before a single message is
 * considered. Schemas are captured here for exactly that reason.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/prefix-stability.ts
 */

/**
 * Wraps a provider and records the *whole* request — schemas and messages —
 * as the provider received it.
 */
class RecordingProvider implements AiProvider {
  readonly schemas: string[] = [];
  readonly messages: ChatMessage[][] = [];

  constructor(private inner: AiProvider) {}

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.schemas.push(JSON.stringify(options.tools ?? []));
    this.messages.push(messages.map((message) => ({ ...message })));
    yield* this.inner.streamChat(messages, options);
  }
}

const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };
const text = (value: string) => ({ type: "text" as const, text: value });

/**
 * Serialize one request the way a prefix cache sees it: an ordered, per-message
 * encoding where any change to an earlier message shifts everything after it.
 */
function serializeRequest(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  return messages.map((message) => JSON.stringify(message));
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}

async function main(): Promise<void> {
  const task = taskById("pagination-last-page");
  const workspace = mkdtempSync(join(tmpdir(), "prefix-stability-"));
  const home = mkdtempSync(join(tmpdir(), "prefix-home-"));
  process.env.MORROW_HOME = home;
  writeFixture(workspace, task.files);

  const fixed =
    "export function paginate(items, perPage) {\n" +
    "  if (!(perPage >= 1)) throw new RangeError('perPage must be at least 1');\n" +
    "  const pages = [];\n" +
    "  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));\n" +
    "  return pages;\n" +
    "}\n";

  // A deliberately ordinary run: look at the code, look at the spec, fix it,
  // verify it, answer. Nothing here is adversarial to caching.
  const provider = new MockProvider({
    chunks: [
      [tool("c0", "inspect_workspace", {}), done],
      [tool("c1", "read_file", { path: "paginate.js" }), done],
      [tool("c2", "read_file", { path: "SPEC.md" }), done],
      [tool("c3", "create_file", { path: "paginate.js", content: fixed }), done],
      [tool("c4", "run_command", { executable: "node", args: ["repro.mjs"], purpose: "verify" }), done],
      [text("Fixed the final-page truncation and added the RangeError guard."), done],
    ],
    delayMs: 0,
  });

  const recording = new RecordingProvider(provider);
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "Prefix probe", workspacePath: workspace, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "probe", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: task.prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: true,
    decision: {
      version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "prefix probe",
      fallbackUsed: false, overridden: true, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
    },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });

  await executeAgentChatTask({ db, taskId: "t", provider: recording, maxTurns: 8 });

  // Schemas first: they sit in front of every message, so a change here
  // invalidates the entire request, not just the part that changed.
  console.log("Tool schemas, per request:");
  const firstSchema = recording.schemas[0] ?? "";
  let schemaChurn = 0;
  for (let index = 0; index < recording.schemas.length; index++) {
    const schema = recording.schemas[index]!;
    const toolCount = (JSON.parse(schema) as unknown[]).length;
    const identical = schema === recording.schemas[Math.max(0, index - 1)]!;
    if (index > 0 && !identical) schemaChurn++;
    console.log(
      `  request ${index + 1}: ${String(toolCount).padStart(2)} tool(s), ${String(schema.length).padStart(6)} chars` +
      `${index === 0 ? "" : identical ? "  unchanged" : "  CHANGED from the previous request"}`,
    );
  }
  console.log(
    schemaChurn === 0
      ? `  → identical across all ${recording.schemas.length} requests (${firstSchema.length} chars), so the schema block caches.\n`
      : `  → changed on ${schemaChurn} request(s); each change invalidates the whole prompt, messages included.\n`,
  );

  const requests = recording.messages.map((messages) => serializeRequest(messages as unknown as Record<string, unknown>[]));
  console.log(`${requests.length} provider request(s) captured.\n`);

  let reusable = 0;
  let resent = 0;
  console.log(
    "req  msgs   chars   carried-over   re-sent   verdict",
  );
  for (let index = 0; index < requests.length; index++) {
    const current = requests[index]!;
    const currentJoined = current.join("\n");
    if (index === 0) {
      console.log(`${String(index + 1).padStart(3)}  ${String(current.length).padStart(4)}  ${String(currentJoined.length).padStart(6)}          —         —   first request, all of it is new`);
      continue;
    }
    const previous = requests[index - 1]!;
    const previousJoined = previous.join("\n");
    const shared = commonPrefixLength(previousJoined, currentJoined);
    // What a cache could have carried over is the whole of the previous
    // request. Anything of it not reproduced verbatim at the front of this one
    // is context already paid for and now being paid for again.
    const couldCarry = previousJoined.length;
    const lost = couldCarry - shared;
    reusable += couldCarry;
    resent += lost;

    const firstDivergentMessage = current.findIndex((message, position) => previous[position] !== message);
    const verdict = lost === 0
      ? "append-only — fully cacheable"
      : `PREFIX BROKEN at message ${firstDivergentMessage} (${lost} chars re-sent)`;
    console.log(`${String(index + 1).padStart(3)}  ${String(current.length).padStart(4)}  ${String(currentJoined.length).padStart(6)}  ${String(shared).padStart(13)}  ${String(lost).padStart(8)}   ${verdict}`);

    if (lost > 0 && firstDivergentMessage >= 0) {
      const before = previous[firstDivergentMessage] ?? "(absent)";
      const after = current[firstDivergentMessage] ?? "(absent)";
      console.log(`        was: ${before.slice(0, 160)}`);
      console.log(`        now: ${after.slice(0, 160)}`);
    }
  }

  // Prefix stability only says the context is cacheable. It says nothing about
  // how much new content each turn adds, which is what is actually billed at
  // the uncached rate. Name the appended content so the per-turn cost has a
  // source rather than a size.
  console.log("\nWhat each turn appends:");
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    const appended = requests[index]!.slice(previous.length);
    const total = appended.reduce((sum, message) => sum + message.length, 0);
    console.log(`  request ${index + 1}: +${total} chars`);
    for (const message of appended) {
      const parsed = JSON.parse(message) as { role?: string; content?: unknown; toolCalls?: unknown };
      const label = parsed.role === "tool" ? "tool result" : String(parsed.role ?? "?");
      console.log(`      ${label.padEnd(12)} ${String(message.length).padStart(6)} chars  ${message.slice(0, 110).replace(/\s+/g, " ")}`);
    }
  }

  console.log("");
  if (resent === 0) {
    console.log("Every request began with the previous one, byte for byte. Morrow's context is append-only, so uncached input is genuinely new content, not churn.");
  } else {
    const share = (resent / reusable) * 100;
    console.log(`${resent} of ${reusable} carried-over characters (${share.toFixed(1)}%) were invalidated by prefix churn.`);
    console.log("That share of the conversation is re-billed at the uncached rate on every affected request.");
  }

  db.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
