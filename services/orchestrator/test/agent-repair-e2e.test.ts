import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { recoverRunningTasks } from "../src/recovery.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { taskContinuationsRepository } from "../src/repositories/task-continuations.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "../../../fixtures/agent-repair");

// The exact unified diff the mocked model proposes to repair the seeded defect.
// Built from explicit lines so the context matches the fixture byte-for-byte.
const REPAIR_PATCH = [
  "--- a/src/math.mjs",
  "+++ b/src/math.mjs",
  "@@ -1,4 +1,4 @@",
  " export function add(a, b) {",
  "   // Defect: subtracts instead of adds; the repair changes minus to plus.",
  "-  return a - b;",
  "+  return a + b;",
  " }",
  "",
].join("\n");

function tool(id: string, index: number, name: string, args: unknown): ProviderChunk {
  return {
    type: "tool_call",
    toolCalls: [{ id, index, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}
const done: ProviderChunk = { type: "done" };
const text = (t: string): ProviderChunk => ({ type: "text", text: t });

function copyFixture(dest: string): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  mkdirSync(join(dest, "test"), { recursive: true });
  writeFileSync(join(dest, "package.json"), readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"));
  writeFileSync(join(dest, "src", "math.mjs"), readFileSync(join(FIXTURE_DIR, "src", "math.mjs"), "utf8"));
  writeFileSync(join(dest, "test", "run.mjs"), readFileSync(join(FIXTURE_DIR, "test", "run.mjs"), "utf8"));
}

function seedAgentTask(db: any, workspacePath: string) {
  const projects = projectRepository(db);
  const convs = conversationsRepository(db);
  const tasks = taskRepository(db);
  const routingRepo = taskRoutingRepository(db);
  const records = taskRecordsRepository(db);

  const project = projects.createProject({ id: "project-1", name: "E2E Project", workspacePath, createdAt: new Date().toISOString() });
  const conversation = convs.createConversation({ id: "conv-1", projectId: project.id, title: "Repair", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  convs.appendMessage({ id: "msg-user", conversationId: conversation.id, role: "user", content: "Fix the failing test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const task = tasks.createTask({ id: "task-1", projectId: project.id, kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  convs.appendMessage({ id: "msg-assistant", conversationId: conversation.id, role: "assistant", content: "", taskId: task.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  routingRepo.upsert({
    taskId: task.id, presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: true,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [] },
    createdAt: new Date().toISOString(),
  });
  records.transitionAgentState(task.id, { id: "state-0", state: "idle", details: {}, createdAt: new Date().toISOString() });
  return { project, conversation, task };
}

function runnerFor(db: any, provider: MockProvider): TaskRunner {
  return new TaskRunner(db, async (deps) => {
    await executeAgentChatTask({
      db: deps.db,
      taskId: deps.taskId,
      provider,
      maxTurns: 12,
      ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
    });
  });
}

async function waitForPendingApproval(app: any, projectId: string, label: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/approvals?status=pending` });
    const pending = res.json();
    if (pending.length > 0) return pending[0].id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for pending approval: ${label}`);
}

describe("Agent Repair E2E Vertical Slice", () => {
  let tempWorkspace: string;
  let tempHome: string;
  let originalEnv: NodeJS.ProcessEnv;
  let app: any;
  let db: any;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempHome = mkdtempSync(join(tmpdir(), "morrow-e2e-home-"));
    process.env.MORROW_HOME = tempHome;
    tempWorkspace = mkdtempSync(join(tmpdir(), "morrow-e2e-ws-"));
    copyFixture(tempWorkspace);
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (app) { try { await app.close(); } catch { /* ignore */ } app = undefined; }
    if (db) { try { db.close(); } catch { /* ignore */ } db = undefined; }
    rmSync(tempWorkspace, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("discovers the test command, repairs the defect, verifies the fix, and rolls back", async () => {
    db = openDatabase(":memory:");
    const tasks = taskRepository(db);
    const convs = conversationsRepository(db);
    const { project, task } = seedAgentTask(db, tempWorkspace);

    const provider = new MockProvider({
      delayMs: 5,
      chunks: [
        // 1. Inspect the project to identify the test command and the test.
        [tool("tc-1", 0, "read_file", { path: "package.json" }), done],
        // 2. Run the test (it fails) — requires command approval.
        [text("Running the project's test command."), tool("tc-2", 0, "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Run the failing test" }), done],
        // 3. Inspect the source implicated by the failure.
        [text("The test failed. Reading the source."), tool("tc-3", 0, "read_file", { path: "src/math.mjs" }), done],
        // 4. Propose the exact unified diff — requires patch approval.
        [text("The defect subtracts instead of adding. Proposing a fix."), tool("tc-4", 0, "propose_patch", { patch: REPAIR_PATCH, explanation: "Add instead of subtract", files: ["src/math.mjs"] }), done],
        // 5. Re-run the test to verify (now passes) — requires command approval.
        [text("Patch applied. Verifying."), tool("tc-5", 0, "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Verify the fix" }), done],
        // 6. Report verified success.
        [text("Verified: the test now passes."), done],
      ],
    });

    const runner = runnerFor(db, provider);
    app = buildServer({ db, runner, sseIntervalMs: 10 });
    await app.listen({ host: "127.0.0.1", port: 0 });

    runner.run(task.id);

    // (2) First approval is the failing-test command, and it has NOT run yet.
    const cmd1 = await waitForPendingApproval(app, project.id, "first command");
    const a1 = (await app.inject({ method: "GET", url: `/api/approvals/${cmd1}` })).json();
    expect(a1.kind).toBe("command");
    expect(a1.details.executable).toBe("node");
    expect(a1.details.args).toEqual(["test/run.mjs"]);
    // No run_command result is persisted before approval.
    const preRun = convs.listToolCallsForTask(task.id).find((t: any) => t.toolName === "run_command");
    expect(preRun?.resultJson ?? null).toBeNull();

    await app.inject({ method: "POST", url: `/api/approvals/${cmd1}/resolve`, payload: { projectId: project.id, decision: "allow_once" } });

    // (4) Patch approval carries the exact diff for display.
    const patchApproval = await waitForPendingApproval(app, project.id, "patch");
    const a2 = (await app.inject({ method: "GET", url: `/api/approvals/${patchApproval}` })).json();
    expect(a2.kind).toBe("change_set");
    expect(a2.details.diff).toContain("+  return a + b;");
    // Patch has NOT been applied yet — file is still buggy.
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");

    await app.inject({ method: "POST", url: `/api/approvals/${patchApproval}/resolve`, payload: { projectId: project.id, decision: "allow_once" } });

    // (5) Verification command approval.
    const cmd2 = await waitForPendingApproval(app, project.id, "verify command");
    await app.inject({ method: "POST", url: `/api/approvals/${cmd2}/resolve`, payload: { projectId: project.id, decision: "allow_once" } });

    await runner.waitFor(task.id);

    // Task completed and the patch is on disk.
    expect(tasks.getTaskById(task.id)!.status).toBe("completed");
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a + b;");

    // Genuine exit-code flip: first run failed, verification run passed.
    const runCalls = convs.listToolCallsForTask(task.id).filter((t: any) => t.toolName === "run_command");
    expect(runCalls.length).toBe(2);
    const exit = (t: any) => JSON.parse(t.resultJson).exitCode;
    expect(exit(runCalls[0])).not.toBe(0);
    expect(exit(runCalls[1])).toBe(0);

    // (15) /diff shows the exact Morrow-owned change.
    const diff = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/diff` })).json();
    expect(diff.diff).toContain("+  return a + b;");
    expect(diff.files).toContain("src/math.mjs");

    // Backups exist under MORROW_HOME.
    expect(existsSync(join(tempHome, "backups"))).toBe(true);

    // (17) /undo restores the original file.
    const undo = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/undo` })).json();
    expect(undo.status).toBe("success");
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");

    // (18) The original (failing) test fails again after undo.
    let restoredFails = false;
    try {
      execFileSync("node", ["test/run.mjs"], { cwd: tempWorkspace, stdio: "pipe" });
    } catch {
      restoredFails = true;
    }
    expect(restoredFails).toBe(true);
  }, 45000);

  it("denial prevents command execution and patch application, leaving files untouched", async () => {
    db = openDatabase(":memory:");
    const tasks = taskRepository(db);
    const convs = conversationsRepository(db);
    const { project, task } = seedAgentTask(db, tempWorkspace);

    const provider = new MockProvider({
      delayMs: 5,
      chunks: [
        [text("Running the test."), tool("tc-1", 0, "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Run test" }), done],
        [text("Proposing a fix."), tool("tc-2", 0, "propose_patch", { patch: REPAIR_PATCH, explanation: "Add instead of subtract", files: ["src/math.mjs"] }), done],
        [text("Understood — no changes were made."), done],
      ],
    });

    const runner = runnerFor(db, provider);
    app = buildServer({ db, runner, sseIntervalMs: 10 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    runner.run(task.id);

    const cmd = await waitForPendingApproval(app, project.id, "command");
    await app.inject({ method: "POST", url: `/api/approvals/${cmd}/resolve`, payload: { projectId: project.id, decision: "deny" } });

    const patch = await waitForPendingApproval(app, project.id, "patch");
    await app.inject({ method: "POST", url: `/api/approvals/${patch}/resolve`, payload: { projectId: project.id, decision: "deny" } });

    await runner.waitFor(task.id);

    // Denied command never produced an exit code (executor never ran).
    const runCall = convs.listToolCallsForTask(task.id).find((t: any) => t.toolName === "run_command");
    expect(runCall).toBeDefined();
    expect(runCall!.status).toBe("failed");
    expect(JSON.parse(runCall!.resultJson!).error).toMatch(/denied/i);

    // Denied patch left the file unchanged and produced no applied change set.
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");
    expect(changeSetsRepository(db).listByTask(task.id).some((c) => c.state === "applied")).toBe(false);
    const diff = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/diff` })).json();
    expect(diff.diff ?? null).toBeNull();
  }, 30000);

  it("persists task, approval, continuation, and change-set records across a restart and resumes", async () => {
    const dbFile = join(tempHome, "restart.db");

    // ── First process: run until it blocks on the command approval, then crash.
    const db1 = openDatabase(dbFile);
    const { project, task } = seedAgentTask(db1, tempWorkspace);
    const provider1 = new MockProvider({
      delayMs: 5,
      chunks: [[text("Running the test."), tool("tc-1", 0, "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Run test" }), done]],
    });
    const runner1 = runnerFor(db1, provider1);
    runner1.run(task.id);

    const approvals1 = approvalsRepository(db1);
    const continuations1 = taskContinuationsRepository(db1);
    const start = Date.now();
    while (approvals1.listByProject(project.id, "pending").length === 0) {
      if (Date.now() - start > 10000) throw new Error("Timeout waiting for pre-restart approval");
      await new Promise((r) => setTimeout(r, 30));
    }
    // Before restart: a resumable continuation is persisted and the command has not run.
    const cont = continuations1.get(task.id);
    expect(cont?.toolName).toBe("run_command");
    expect(cont?.args.executable).toBe("node");
    const approvalId = approvals1.listByProject(project.id, "pending")[0]!.id;
    db1.close(); // simulate process crash (approval never resolved in this process)

    // ── Second process: reopen the same database file.
    const db2 = openDatabase(dbFile);
    const tasks2 = taskRepository(db2);
    const records2 = taskRecordsRepository(db2);
    const continuations2 = taskContinuationsRepository(db2);

    // (19) Records survived the reopen.
    expect(approvalsRepository(db2).get(approvalId)?.status).toBe("pending");
    expect(continuations2.get(task.id)?.toolName).toBe("run_command");

    // Recovery marks the in-flight task interrupted; the continuation is preserved.
    recoverRunningTasks(db2);
    expect(tasks2.getTaskById(task.id)!.status).toBe("interrupted");
    expect(continuations2.get(task.id)).toBeDefined();

    // (20) A fresh server resumes the task when the persisted approval is resolved.
    const provider2 = new MockProvider({
      delayMs: 5,
      chunks: [[text("Resumed after restart; the approved command was executed."), done]],
    });
    const runner2 = runnerFor(db2, provider2);
    app = buildServer({ db: db2, runner: runner2, sseIntervalMs: 10 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    db = db2;

    await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: project.id, decision: "allow_once" } });
    await runner2.waitFor(task.id);

    // The task completed after resume, the command ran (exit code recorded), and
    // the continuation was cleaned up.
    expect(tasks2.getTaskById(task.id)!.status).toBe("completed");
    expect(records2.getAgentState(task.id)?.state).toBe("completed");
    const convs2 = conversationsRepository(db2);
    const runCall = convs2.listToolCallsForTask(task.id).find((t: any) => t.toolName === "run_command");
    expect(runCall).toBeDefined();
    expect(runCall!.status).toBe("completed");
    expect(typeof JSON.parse(runCall!.resultJson!).exitCode).toBe("number");
    expect(continuations2.get(task.id)).toBeUndefined();
  }, 45000);
});
