import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedYolo(db: any, workspacePath: string, prompt = "verify it", missionLinked = false) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const missionId = missionLinked
    ? new MissionService({ repo: missionsRepository(db), getWorkspacePath: () => workspacePath, backupDir: join(workspacePath, ".morrow-checkpoints") })
        .create("p", { objective: prompt }).id
    : undefined;
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", ...(missionId ? { missionId } : {}), kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
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

  it("does not clear a failed verification merely because a later workspace write succeeds", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [tool("w1", "create_file", { path: "after-failure.txt", content: "changed\n" }), done],
        [text("fixed"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(conversationsRepository(db).listToolCallsForTask("t").map((call: any) => call.id)).toEqual(["v1", "w1"]);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(false);
  });

  it("invalidates a passing verification when a later workspace write changes the verified state", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [tool("w1", "create_file", { path: "after-pass.txt", content: "changed\n" }), done],
        [text("still verified"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(false);
  });

  it("does not report completed when a workspace write was never followed by verification", async () => {
    seedYolo(db, ws, "change the workspace and verify it", true);
    const provider = new MockProvider({
      chunks: [
        [tool("w1", "create_file", { path: "unverified.txt", content: "changed\n" }), done],
        [text("done without checking"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(false);
  });

  it("still reports completed for an ordinary successful run", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [text("intermediate narration"), tool("v2", "git_status", {}), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")!.content).toBe("done");
    const terminalEvents = taskRecordsRepository(db).listEvents("t").filter((event: any) => event.type === "task.completed");
    expect(terminalEvents).toHaveLength(1);
  });

  it("does not report completed when a provider ends after tools without a final answer", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("t").some((e: any) => e.type === "task.completed")).toBe(false);
  });

  it("retries one empty post-tool provider turn before interrupting", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [done],
        [text("verified after transient empty provider response"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")!.content).toContain("verified after transient empty provider response");
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

  it("does not report completed when a broken configured verification script was silently worked around", async () => {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(1)"' } }));
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        // The project's own configured "test" script actually fails.
        [tool("v1", "run_command", { executable: "npm", args: ["test"], purpose: "run the project's test suite" }), done],
        // A substitute for the same purpose is used instead, and it passes.
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "run tests directly since npm test is broken" }), done],
        // The final answer never discloses that npm test itself is still broken.
        [text("All tests pass."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.completed")).toBe(false);
    expect(events.some((e: any) => e.type === "task.interrupted" && e.payload?.reason === "undisclosed_verification_substitution")).toBe(true);
  });

  it("reports completed when the substitution for a broken configured script is honestly disclosed", async () => {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(1)"' } }));
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "npm", args: ["test"], purpose: "run the project's test suite" }), done],
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "run tests directly since npm test is broken" }), done],
        [text("Ran the tests directly and all pass, but note the project's own `npm test` script is still broken (unrelated to this change)."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("still reports completed when no configured verification script exists to disclose", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "run tests directly since npm test is broken" }), done],
        [text("All tests pass."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not report completed when the substitute is run via the package manager itself (pnpm exec) without disclosure", async () => {
    // Reproduces the exact live pattern observed re-running Journey L against
    // DeepSeek after the fix: the model ran the configured script through
    // pnpm, it failed, then used "pnpm exec ..." (still executable "pnpm",
    // but bypassing the configured script) as the substitute.
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: "vitest run --bad-flag" } }));
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "pnpm", args: ["test"], purpose: "Run full test suite" }), done],
        [tool("v2", "run_command", { executable: "pnpm", args: ["exec", "node", "-e", "process.exit(0)"], purpose: "Run test suite with correct vitest command" }), done],
        [text("All tests pass."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted" && e.payload?.reason === "undisclosed_verification_substitution")).toBe(true);
  });

  it("reports completed for natural disclosure phrasing that names the script and command context without saying the literal package manager name", async () => {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(1)"' } }));
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "npm", args: ["test"], purpose: "Run full test suite" }), done],
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "Run test suite with correct vitest command" }), done],
        [text("10/10 tests pass. Note: the project's `package.json` test script is broken (unrelated to this change); I ran the tests directly instead."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });
});
