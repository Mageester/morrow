import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
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
import { executeAgentChatTask, workspaceWritePaths } from "../src/execution/agent.js";

function seed(db: any, workspacePath: string, prompt: string) {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("workspaceWritePaths", () => {
  it("reads the delivered path from create_file arguments", () => {
    expect(workspaceWritePaths(JSON.stringify({ path: "src/new.ts" }))).toEqual(["src/new.ts"]);
  });

  it("reads delivered paths out of a unified diff, which the arguments never name directly", () => {
    const patch = [
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1 +1 @@",
      "-export const A = 1;",
      "+export const A = 2;",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
      "",
    ].join("\n");
    expect(workspaceWritePaths(JSON.stringify({ patch })).sort()).toEqual(["src/config.ts", "src/other.ts"]);
  });

  it("treats a deletion hunk as delivering nothing", () => {
    const patch = ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-const x = 1;", ""].join("\n");
    expect(workspaceWritePaths(JSON.stringify({ patch }))).toEqual([]);
  });

  it("returns nothing for malformed or empty arguments", () => {
    expect(workspaceWritePaths("not json")).toEqual([]);
    expect(workspaceWritePaths(null)).toEqual([]);
    expect(workspaceWritePaths(JSON.stringify(["array"]))).toEqual([]);
  });
});

describe("patch-only delivery", () => {
  let db: any;
  let ws: string;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-patch-delivery-")));
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(ws, { recursive: true, force: true });
  });

  it("completes a task whose only delivered artifact is an edit to an existing file", async () => {
    writeFileSync(join(ws, "config.js"), "exports.TIMEOUT_MS = 1000;\n");
    seed(db, ws, "Change the timeout in config.js to 5000.");

    const patch = [
      "--- a/config.js",
      "+++ b/config.js",
      "@@ -1 +1 @@",
      "-exports.TIMEOUT_MS = 1000;",
      "+exports.TIMEOUT_MS = 5000;",
      "",
    ].join("\n");
    const provider = new MockProvider({
      chunks: [
        [tool("p1", "propose_patch", { patch }), done],
        [text("Raised TIMEOUT_MS to 5000 in config.js."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    // The patch applied and is the delivered artifact. Before the fix the
    // completion contract found no artifact at all — `propose_patch` names its
    // files only inside the diff — and interrupted a finished edit.
    expect(conversationsRepository(db).listToolCallsForTask("t").find((call: any) => call.id === "p1")?.status).toBe("completed");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((event: any) => event.type === "task.interrupted")).toBe(false);
  }, 60_000);
});
