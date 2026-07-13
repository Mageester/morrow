import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { TaskRunner, type TaskExecutor } from "../src/runner.js";

const now = "2026-01-01T00:00:00.000Z";

// A gated executor that simply parks until its task is aborted. It never
// transitions task status, so the test seeds the desired DB status directly and
// asserts what cancellation does to persisted state — fully deterministic, no
// sleeps.
const parkUntilAborted: TaskExecutor = ({ abortSignal }) =>
  new Promise<void>((resolve) => {
    if (abortSignal?.aborted) return resolve();
    abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });

function seedProject(db: ReturnType<typeof openDatabase>) {
  projectRepository(db).createProject({ id: "p", name: "p", workspacePath: process.cwd(), createdAt: now });
}

// Insert a task row directly at a chosen status (bypasses the runner's queued
// default) so we can stage running parents/children deterministically.
function seedTask(db: ReturnType<typeof openDatabase>, id: string, status: string, parentTaskId?: string, kind = "inspect_workspace") {
  taskRepository(db).createTask({ id, projectId: "p", kind, status, ...(parentTaskId ? { parentTaskId } : {}), createdAt: now });
}

describe("cancellation lifecycle — subagent propagation (reproduction)", () => {
  it("cancelling a running parent cancels its running child", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "child", "running", "parent");
    const tasks = taskRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");
    runner.run("child");

    runner.cancel("parent");

    expect(tasks.getTaskById("parent")?.status).toBe("cancelled");
    expect(tasks.getTaskById("child")?.status).toBe("cancelled");
    db.close();
  });

  it("cancelling a running parent cancels a queued child", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "child", "queued", "parent");
    const tasks = taskRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");

    runner.cancel("parent");

    expect(tasks.getTaskById("parent")?.status).toBe("cancelled");
    expect(tasks.getTaskById("child")?.status).toBe("cancelled");
    db.close();
  });

  it("propagates through nested descendants (grandchild)", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "child", "running", "parent");
    seedTask(db, "grandchild", "running", "child");
    const tasks = taskRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");
    runner.run("child");
    runner.run("grandchild");

    runner.cancel("parent");

    expect(tasks.getTaskById("child")?.status).toBe("cancelled");
    expect(tasks.getTaskById("grandchild")?.status).toBe("cancelled");
    db.close();
  });

  it("cancelling a child leaves the parent and siblings running (isolation)", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "childA", "running", "parent");
    seedTask(db, "childB", "running", "parent");
    const tasks = taskRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");
    runner.run("childA");
    runner.run("childB");

    runner.cancel("childA");

    expect(tasks.getTaskById("childA")?.status).toBe("cancelled");
    expect(tasks.getTaskById("parent")?.status).toBe("running");
    expect(tasks.getTaskById("childB")?.status).toBe("running");
    db.close();
  });

  it("does not touch an unrelated task tree", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "child", "running", "parent");
    seedTask(db, "other", "running");
    const tasks = taskRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");
    runner.run("child");
    runner.run("other");

    runner.cancel("parent");

    expect(tasks.getTaskById("other")?.status).toBe("running");
    db.close();
  });

  it("already-terminal descendants are left unchanged; duplicate cancel is idempotent", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "parent", "running");
    seedTask(db, "doneChild", "verified", "parent");
    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db);
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("parent");

    runner.cancel("parent");
    const eventsAfterFirst = records.listEvents("parent").length;
    runner.cancel("parent"); // duplicate — must be a no-op, no throw

    expect(tasks.getTaskById("doneChild")?.status).toBe("verified");
    expect(tasks.getTaskById("parent")?.status).toBe("cancelled");
    expect(records.listEvents("parent").length).toBe(eventsAfterFirst);
    db.close();
  });
});

describe("cancellation lifecycle — continuation resume (reproduction)", () => {
  it("resuming an interrupted agent_chat task does not fail on an invalid running->running transition", async () => {
    const prevMock = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    const work = mkdtempSync(join(tmpdir(), "morrow-cancel-resume-"));
    writeFileSync(join(work, "evidence.txt"), "ok");
    const db = openDatabase(":memory:");
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: work, createdAt: ts });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c1", projectId: "p", title: "C", createdAt: ts, updatedAt: ts });
    convs.appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    const tasks = taskRepository(db);
    tasks.createTask({ id: "agent", projectId: "p", kind: "agent_chat", status: "interrupted", createdAt: ts });
    convs.appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "agent", streamingState: "interrupted", createdAt: ts, updatedAt: ts });
    const records = taskRecordsRepository(db);
    // Mirror a restart-interrupted agent: idle -> interrupted agent state.
    records.transitionAgentState("agent", { id: "s0", state: "idle", details: {}, createdAt: ts });
    records.transitionAgentState("agent", { id: "s1", state: "interrupted", details: { reason: "restart" }, createdAt: ts });

    const runner = new TaskRunner(db);
    const app = buildServer({ db, runner });
    try {
      const res = await app.inject({ method: "POST", url: "/api/tasks/agent/resume", payload: { projectId: "p" } });
      expect(res.statusCode).toBe(202);
      await runner.waitFor("agent");

      const status = tasks.getTaskById("agent")?.status;
      expect(status).not.toBe("failed");
      const events = records.listEvents("agent").map((e) => e.type);
      expect(events).not.toContain("task.failed");
    } finally {
      await app.close();
      db.close();
      rmSync(work, { recursive: true, force: true });
      if (prevMock === undefined) delete process.env.MOCK_PROVIDER; else process.env.MOCK_PROVIDER = prevMock;
    }
  });
});

describe("cancellation lifecycle — route and race semantics", () => {
  it("reports accepted, duplicate, and terminal cancellation without throwing", async () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "running", "running");
    seedTask(db, "done", "verified");
    const runner = new TaskRunner(db, parkUntilAborted);
    runner.run("running");
    const app = buildServer({ db, runner });
    try {
      const first = await app.inject({ method: "POST", url: "/api/tasks/running/cancel" });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ taskId: "running", status: "cancelled", outcome: "cancelled" });

      const duplicate = await app.inject({ method: "POST", url: "/api/tasks/running/cancel" });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toMatchObject({ taskId: "running", status: "cancelled", outcome: "already_cancelled" });

      const terminal = await app.inject({ method: "POST", url: "/api/tasks/done/cancel" });
      expect(terminal.statusCode).toBe(409);
      expect(terminal.json().error).toMatchObject({ code: "TASK_ALREADY_TERMINAL" });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records a lost cancel/complete race as a normal route outcome, not a 500", async () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "done", "completed");
    const runner = new TaskRunner(db, parkUntilAborted);
    const app = buildServer({ db, runner });
    try {
      const res = await app.inject({ method: "POST", url: "/api/tasks/done/cancel" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: "TASK_ALREADY_TERMINAL",
        message: expect.stringContaining("already completed"),
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not let a late approval revive a cancelled continuation", async () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    seedTask(db, "agent", "cancelled", undefined, "agent_chat");
    approvalsRepository(db).create({
      id: "approval",
      taskId: "agent",
      projectId: "p",
      kind: "command",
      summary: "Run command: node -v",
      details: { executable: "node", args: ["-v"], cwd: "", risk: "medium", purpose: "test", toolCallId: "call-1" },
      createdAt: now,
    });
    const runner = new TaskRunner(db, parkUntilAborted);
    const app = buildServer({ db, runner });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/approval/resolve",
        payload: { projectId: "p", decision: "allow_once" },
      });

      expect(res.statusCode).toBe(200);
      expect(taskRepository(db).getTaskById("agent")?.status).toBe("cancelled");
      expect(runner.isActive("agent")).toBe(false);
    } finally {
      await app.close();
      db.close();
    }
  });
});
