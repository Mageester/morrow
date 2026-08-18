import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { contextSummariesRepository } from "../src/repositories/context-summaries.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { ChatMessage } from "../src/provider/base.js";

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

const WORKING_SET_PREFIX = "Work you already completed";

function workingSet(messages: ChatMessage[] | undefined): string | undefined {
  return messages?.find((message) => message.role === "system" && message.content.startsWith(WORKING_SET_PREFIX))?.content;
}

describe("chat conversation memory across turns", () => {
  let db: any;
  let ws: string;
  let sequence = 0;

  const iso = () => new Date(Date.UTC(2026, 7, 1, 0, 0, sequence++)).toISOString();

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-chat-memory-")));
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src/config.js"), "exports.TIMEOUT_MS = 1000;\n");
    writeFileSync(join(ws, "src/client.js"), "exports.go = () => 1;\n");
    db = openDatabase(":memory:");
    sequence = 0;
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: iso() });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: iso(), updatedAt: iso() });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(ws, { recursive: true, force: true });
  });

  /** Seed one user/assistant turn in conversation `c` and run it. */
  async function runTurn(id: string, prompt: string, chunks: any[][], options: { worktreeId?: string } = {}) {
    const convs = conversationsRepository(db);
    convs.appendMessage({ id: `mu-${id}`, conversationId: "c", role: "user", content: prompt, createdAt: iso(), updatedAt: iso() });
    taskRepository(db).createTask({
      id,
      projectId: "p",
      kind: "agent_chat",
      status: "queued",
      ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
      createdAt: iso(),
    });
    convs.appendMessage({ id: `ma-${id}`, conversationId: "c", role: "assistant", content: "", taskId: id, createdAt: iso(), updatedAt: iso() });
    taskRoutingRepository(db).upsert({
      taskId: id, presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
      createdAt: iso(),
    });
    taskRecordsRepository(db).transitionAgentState(id, { id: `s-${id}`, state: "idle", details: {}, createdAt: iso() });
    const provider = new MockProvider({ chunks, delayMs: 1 });
    await executeAgentChatTask({ db, taskId: id, provider, maxTurns: 8 });
    return provider;
  }

  it("carries the first turn's tool work into the second turn's prompt", async () => {
    const first = await runTurn("t1", "Read the config and the client.", [
      [tool("r1", "read_file", { path: "src/config.js" }), done],
      [tool("r2", "read_file", { path: "src/client.js" }), done],
      [text("Two small modules."), done],
    ]);
    // Nothing preceded the first turn, so it carries no working set.
    expect(workingSet(first.requests[0])).toBeUndefined();

    const second = await runTurn("t2", "Which one holds the timeout?", [[text("src/config.js does."), done]]);
    const memory = workingSet(second.requests[0]);

    expect(memory).toBeDefined();
    expect(memory).toContain("src/config.js");
    expect(memory).toContain("src/client.js");
    // Paths and sizes only — the file bodies stay out of the digest.
    expect(memory).not.toContain("TIMEOUT_MS");
  });

  it("records the injected working set as an inspectable execution event", async () => {
    await runTurn("t1", "Read the config.", [
      [tool("r1", "read_file", { path: "src/config.js" }), done],
      [text("Read it."), done],
    ]);
    await runTurn("t2", "And now?", [[text("Nothing further."), done]]);

    const event = taskRecordsRepository(db).listEvents("t2").find((entry: any) => entry.type === "context.working_set");
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({ priorTurns: 1, truncated: false });
    expect(event!.payload.entryCount).toBeGreaterThan(0);
    expect(event!.payload.bytes).toBeGreaterThan(0);
  });

  it("does not resurrect work the user compacted away", async () => {
    await runTurn("t1", "Read the config.", [
      [tool("r1", "read_file", { path: "src/config.js" }), done],
      [text("Read it."), done],
    ]);

    // A user-requested compaction (task_id NULL) covering the first turn.
    const messages = conversationsRepository(db).listMessages("c");
    contextSummariesRepository(db).record({
      id: "summary-1",
      projectId: "p",
      conversationId: "c",
      taskId: null,
      method: "deterministic",
      content: "Earlier: looked at the configuration.",
      sourceStartIndex: 0,
      sourceEndIndex: messages.length - 1,
      sourceMessageCount: messages.length,
      createdAt: iso(),
    });

    const second = await runTurn("t2", "Carry on.", [[text("Carrying on."), done]]);
    expect(workingSet(second.requests[0])).toBeUndefined();
  });

  it("does not carry work from a turn that ran in a different worktree", async () => {
    const worktreePath = join(ws, "..", `worktree-${Date.now()}`);
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src/config.js"), "exports.TIMEOUT_MS = 2000;\n");
    db.prepare(
      "INSERT INTO worktrees (id,project_id,branch,path,base_ref,status,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("wt-1", "p", "feature/x", realpathSync(worktreePath), "main", "active", iso());

    await runTurn("t1", "Read the config.", [
      [tool("r1", "read_file", { path: "src/config.js" }), done],
      [text("Read it."), done],
    ], { worktreeId: "wt-1" });

    // The prior turn's paths refer to a different checkout, so they are not
    // facts about this one.
    const second = await runTurn("t2", "Carry on.", [[text("Carrying on."), done]]);
    expect(workingSet(second.requests[0])).toBeUndefined();
  });
});
