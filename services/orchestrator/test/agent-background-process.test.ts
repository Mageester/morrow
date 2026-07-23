import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Full-stack apps need a long-running dev server, not a one-shot command.
 * These tests prove the agent can start one in the background (without
 * run_command's blocking wait-for-exit), poll its output, and stop it — the
 * capability gap that made "build me a full-stack app" fail every time
 * (see agent.ts's run_command background:true and the new
 * read_process_output/stop_process tools).
 */

function seed(db: any, workspacePath: string, mode: "agent" | "read-only" = "agent") {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "go", createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode, autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

// Stays alive until killed; prints "ready" immediately so tests can poll for it.
const LONG_RUNNING_SCRIPT = "console.log('ready'); setInterval(() => {}, 1000);";

describe("agent background processes (full-stack dev-server capability)", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "morrow-bgproc-")); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("starts a long-running command in the background instead of blocking until it exits", async () => {
    seed(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs0-"));
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const provider = new MockProvider({
      chunks: [
        [tool("x1", "run_command", { executable: "node", args: ["-e", LONG_RUNNING_SCRIPT], purpose: "start dev server", background: true }), done],
        [text("started"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 4 }));

    const startedAt = Date.now();
    runner.run("t");
    await runner.waitFor("t");
    const elapsedMs = Date.now() - startedAt;

    // A blocking run would still be waiting on the never-exiting process; a
    // background start must return almost immediately.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command")!;
    const result = JSON.parse(call.resultJson!);
    expect(result.processId).toBeTruthy();
    expect(result.status).toBe("running");

    const record = processesRepository(db).get(result.processId);
    expect(record?.status).toBe("running");

    // Clean up the real OS process this test actually spawned, and wait for
    // the exit event to settle before the DB closes (afterEach) — the
    // supervisor's own exit handler writes to it asynchronously.
    await supervisor.terminate(result.processId, { force: true });
    await new Promise((r) => setTimeout(r, 300));
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("lets the agent poll output and stop what it started, sharing one supervisor with the rest of the orchestrator", async () => {
    seed(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs-"));
    // The same ProcessSupervisor instance production shares between the REST
    // process routes and the agent (see index.ts) — injected here so the
    // process this test pre-starts is one the agent's own stop_process call can
    // actually see and terminate (terminate() needs the live in-process handle,
    // not just the DB row).
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const started = await supervisor.start({ projectId: "p", command: "node", args: ["-e", LONG_RUNNING_SCRIPT], cwd: ws });
    // Give it a beat to actually write "ready" to the captured log.
    await new Promise((r) => setTimeout(r, 300));

    const provider = new MockProvider({
      chunks: [
        [tool("x1", "read_process_output", { processId: started.id }), done],
        [tool("x2", "stop_process", { processId: started.id, force: true }), done],
        [text("verified and stopped"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const calls = conversationsRepository(db).listToolCallsForTask("t");

    const readCall = calls.find((c: any) => c.toolName === "read_process_output")!;
    const readResult = JSON.parse(readCall.resultJson!);
    expect(readResult.data).toContain("ready");

    const stopCall = calls.find((c: any) => c.toolName === "stop_process")!;
    const stopResult = JSON.parse(stopCall.resultJson!);
    expect(stopResult.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    const record = processesRepository(db).get(started.id);
    expect(record?.status).not.toBe("running");
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("refuses to read or stop a process belonging to a different project", async () => {
    seed(db, ws);
    const otherWs = mkdtempSync(join(tmpdir(), "morrow-bgproc-other-"));
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs2-"));
    projectRepository(db).createProject({ id: "other", name: "Other", workspacePath: otherWs, createdAt: new Date().toISOString() });
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const started = await supervisor.start({ projectId: "other", command: "node", args: ["-e", LONG_RUNNING_SCRIPT], cwd: otherWs });

    const provider = new MockProvider({
      chunks: [[tool("x1", "read_process_output", { processId: started.id }), done], [text("done"), done]],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "read_process_output");
    expect(call?.status).toBe("failed");
    expect(call?.resultJson).toMatch(/not found/i);

    await supervisor.terminate(started.id, { force: true });
    await new Promise((r) => setTimeout(r, 200));
    rmSync(otherWs, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("denies stop_process outside agent mode, same as run_command", async () => {
    seed(db, ws, "read-only");
    const provider = new MockProvider({
      chunks: [[tool("x1", "stop_process", { processId: "whatever" }), done], [text("done"), done]],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "stop_process");
    expect(call?.status).toBe("failed");
    expect(call?.resultJson).toMatch(/not permitted in read-only mode/);
  });
});
