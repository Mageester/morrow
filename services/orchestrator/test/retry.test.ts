import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import type { TaskStatus } from "@morrow/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedTask(db: Database.Database, status: TaskStatus) {
  const ts = new Date().toISOString();
  projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts });
  conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "C", createdAt: ts, updatedAt: ts });
  taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status, createdAt: ts });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "half-done answer", taskId: "t1", streamingState: "failed", createdAt: ts, updatedAt: ts });
}

describe("retryTask repository", () => {
  let db: Database.Database;
  beforeEach(() => (db = openDatabase(":memory:")));
  afterEach(() => db.close());

  it("resets a failed task to a clean queued state and clears continuation + message", () => {
    seedTask(db, "failed");
    db.prepare("INSERT INTO task_continuations (task_id, tool_call_id, tool_name, args_json, created_at) VALUES (?, ?, ?, ?, ?)").run("t1", "call-1", "run_command", "{}", new Date().toISOString());
    const records = taskRecordsRepository(db);

    const retried = records.retryTask("t1");
    expect(retried.status).toBe("queued");

    expect(db.prepare("SELECT COUNT(*) n FROM task_continuations WHERE task_id = ?").get("t1")).toEqual({ n: 0 });
    const msg = conversationsRepository(db).getMessage("ma");
    expect(msg?.content).toBe("");
    expect(msg?.streamingState).toBe("queued");
  });

  it("retries an interrupted task but refuses completed, verified, cancelled, and running", () => {
    const records = taskRecordsRepository(db);
    seedTask(db, "interrupted");
    expect(records.retryTask("t1").status).toBe("queued");

    for (const status of ["completed", "verified", "cancelled", "running"] as TaskStatus[]) {
      const d = openDatabase(":memory:");
      seedTask(d, status);
      expect(() => taskRecordsRepository(d).retryTask("t1")).toThrow(/can be retried/i);
      d.close();
    }
  });
});

describe("POST /api/tasks/:taskId/retry", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("re-queues a failed task (202) and 404s an unknown task", async () => {
    seedTask(db, "failed");
    const res = await app.inject({ method: "POST", url: "/api/tasks/t1/retry" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("queued");
    expect((await app.inject({ method: "POST", url: "/api/tasks/none/retry" })).statusCode).toBe(404);
  });

  it("409s when the task is not failed or interrupted", async () => {
    seedTask(db, "completed");
    const res = await app.inject({ method: "POST", url: "/api/tasks/t1/retry" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TASK_NOT_RETRYABLE");
  });
});

describe("POST /api/tasks/:taskId/resume", () => {
  it("refuses to resume a persisted task from a different active project", async () => {
    const db = openDatabase(":memory:");
    const runner = new TaskRunner(db, async () => {});
    const app = buildServer({ db, runner });
    try {
      seedTask(db, "interrupted");
      const ts = new Date().toISOString();
      projectRepository(db).createProject({ id: "p2", name: "Different project", workspacePath: tmpdir(), createdAt: ts });

      const res = await app.inject({ method: "POST", url: "/api/tasks/t1/resume", payload: { projectId: "p2" } });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("TASK_PROJECT_MISMATCH");
      expect(taskRepository(db).getTaskById("t1")?.status).toBe("interrupted");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("restarts an interrupted workspace inspection instead of resuming it as already running", async () => {
    const work = mkdtempSync(join(tmpdir(), "morrow-resume-"));
    const db = openDatabase(":memory:");
    const runner = new TaskRunner(db);
    const app = buildServer({ db, runner });
    try {
      writeFileSync(join(work, "readme.txt"), "hello");
      const ts = new Date().toISOString();
      projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: work, createdAt: ts });
      taskRepository(db).createTask({ id: "inspect", projectId: "p1", kind: "inspect_workspace", status: "interrupted", createdAt: ts });

      const res = await app.inject({ method: "POST", url: "/api/tasks/inspect/resume", payload: { projectId: "p1" } });
      expect(res.statusCode).toBe(202);
      await runner.waitFor("inspect");

      expect(taskRepository(db).getTaskById("inspect")?.status).toBe("verified");
    } finally {
      await app.close();
      db.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
