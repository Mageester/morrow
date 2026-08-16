import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { ChatMessage } from "../src/provider/base.js";

/**
 * A model can only self-correct from what it can actually see. This pins the
 * two halves of that contract at the request boundary:
 *
 *   1. a successful mutation is visible as a success, once, with its target;
 *   2. a failed tool call is visible as a failure, with the reason AND a
 *      concrete way to fix it — not a bare "rejected".
 *
 * Live evidence motivating (2): a model sent the workspace's own absolute path
 * and was told only "Workspace path is outside configured workspace", which was
 * both false and unactionable, so it repeated the same mistake indefinitely.
 */
function seed(db: any, workspacePath: string) {
  const at = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: at });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: at, updatedAt: at });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "finish the site", createdAt: at, updatedAt: at });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: at });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: at, updatedAt: at });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: at,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: at });
}

const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});

function toolResultsIn(request: ChatMessage[], toolCallId: string): string[] {
  return request.filter((m) => m.role === "tool" && m.toolCallId === toolCallId).map((m) => m.content);
}

let db: any; let ws: string;
beforeEach(() => { db = openDatabase(":memory:"); ws = mkdtempSync(join(tmpdir(), "morrow-visibility-")); });
afterEach(() => { db.close(); rmSync(ws, { recursive: true, force: true }); });

async function run(provider: MockProvider, maxTurns = 10) {
  const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns }));
  runner.run("t");
  await runner.waitFor("t");
}

describe("tool observations are visible and actionable in the next provider request", () => {
  it("shows a successful write exactly once, as a success naming its target", async () => {
    seed(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("w", "create_file", { path: "assets/site.css", content: "body{}\n" }), done],
        [text("wrote the stylesheet"), done],
      ],
      delayMs: 1,
    });
    await run(provider);

    const next = provider.requests[1]!;
    const results = toolResultsIn(next, "w");
    expect(results).toHaveLength(1);
    const observation = JSON.parse(results[0]!);
    expect(observation).toMatchObject({ status: "success", path: "assets/site.css", changed: true });
    // The assistant's own request for that tool is present exactly once too.
    const requested = next.flatMap((m) => m.toolCalls ?? []).filter((call) => call.id === "w");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.function.name).toBe("create_file");
  });

  it("shows a rejected path as a failure that names the rule and a valid example", async () => {
    seed(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("bad", "list_files", { path: "/etc" }), done],
        [text("stopping"), done],
      ],
      delayMs: 1,
    });
    await run(provider);

    const next = provider.requests[1]!;
    const results = toolResultsIn(next, "bad");
    expect(results).toHaveLength(1);
    const observation = results[0]!;
    // What was wrong, where the boundary is, and what a good value looks like.
    expect(observation).toMatch(/outside this task's workspace root/);
    expect(observation).toContain(ws);
    expect(observation).toMatch(/assets\/site\.css/);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("executes a workspace-contained absolute path instead of rejecting it", async () => {
    seed(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("mk", "create_file", { path: join(ws, "assets", "site.css"), content: "body{}\n" }), done],
        [tool("ls", "list_files", { path: ws }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    await run(provider);

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    expect(calls.find((c: any) => c.id === "mk")!.status).toBe("completed");
    expect(calls.find((c: any) => c.id === "ls")!.status).toBe("completed");
    const listing = JSON.parse(provider.requests[2]!.filter((m) => m.role === "tool" && m.toolCallId === "ls")[0]!.content);
    expect(JSON.stringify(listing)).toContain("assets");
  });
});
