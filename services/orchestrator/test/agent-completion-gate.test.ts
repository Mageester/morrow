import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedYolo(db: any, workspacePath: string, prompt = "verify it") {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("agent completion gate", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-gate-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("does not report completed when the final verification command exits non-zero", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [text("all good"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    // The verification failed (exit 1), so the task must NOT be completed.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.completed")).toBe(false);
  });

  it("reports completed when a failed verification is recovered by a later clean run", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "re-verify" }), done],
        [text("fixed and verified"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    // The later clean run cleared the outstanding failure, so completion is honest.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("still reports completed for an ordinary successful run", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not report completed when a final node --check exits non-zero", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "bad.js", content: "function (\n" }), done],
        [tool("v1", "run_command", { executable: "node", args: ["--check", "bad.js"], purpose: "syntax check" }), done],
        [text("looks good"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
  });

  it("does not report completed when the final required write (visual improvement) fails", async () => {
    seedYolo(db, ws);
    // header declares old=5 but only 2 old lines are present → hunk mismatch.
    const malformed = "--- a/style.css\n+++ b/style.css\n@@ -1,5 +1,2 @@\n body {\n-  color: black;\n";
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "style.css", content: "body {\n  color: black;\n}\n" }), done],
        [tool("p1", "propose_patch", { patch: malformed, explanation: "restyle", files: ["style.css"] }), done],
        [text("styled"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
  });

  it("distinguishes required verification from optional tool failure — an optional failure does not gate", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        // Required write + verify both succeed (clears any outstanding failure).
        [tool("c1", "create_file", { path: "ok.js", content: "console.log('ok');\n" }), done],
        [tool("v1", "run_command", { executable: "node", args: ["--check", "ok.js"], purpose: "verify" }), done],
        // A read-only search fails — this is NOT a required verification, so it
        // must not turn an otherwise-complete task into an incomplete one.
        [tool("s1", "search_text", { query: "" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 10 }));
    runner.run("t");
    await runner.waitFor("t");

    // The search failure is recorded on its tool call, but the task still completes.
    const search = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "search_text");
    expect(search!.status).toBe("failed");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("keeps terminal states mutually exclusive when the gate fires", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(2)"], purpose: "verify" }), done],
        [text("all good"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    const status = taskRepository(db).getTaskById("t")!.status;
    expect(status).toBe("interrupted");
    // Exactly one terminal state — interrupted — never also completed/failed/cancelled.
    expect(["completed", "failed", "cancelled"]).not.toContain(status);
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(true);
    expect(events.some((e: any) => e.type === "task.completed")).toBe(false);
    expect(events.some((e: any) => e.type === "task.failed")).toBe(false);
  });
});
