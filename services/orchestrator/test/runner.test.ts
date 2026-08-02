import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

describe("TaskRunner", () => {
  let db: Database.Database;
  
  beforeEach(() => {
    // Open the database through the real migration runner rather than a
    // hand-written CREATE TABLE fixture. The fixture had drifted from the
    // migrations — it was missing `tasks.idempotency_fingerprint`, so every
    // test in this file failed on task creation with a SqliteError. A
    // duplicated schema is guaranteed to rot; using the production opener means
    // these tests exercise the schema the product actually ships.
    db = openDatabase(":memory:");

    projectRepository(db).createProject({ id: "p1", name: "test", workspacePath: "/test", createdAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    db.close();
  });

  it("returns before gated executor completes and clears active on success", async () => {
    let releaseGate: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let executed = false;

    const runner = new TaskRunner(db, async () => {
      await gate;
      executed = true;
    });

    runner.run("t1");
    expect(executed).toBe(false);

    // Active state tracking
    const activeTasks = (runner as any).activeTasks;
    expect(activeTasks.has("t1")).toBe(true);

    // Rejects duplicate
    expect(() => runner.run("t1")).toThrow(/Duplicate/);

    // task.created is persisted synchronously
    const events = taskRecordsRepository(db).listEvents("t1");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("task.created");

    // Release and wait
    releaseGate!();
    await runner.waitFor("t1");

    expect(executed).toBe(true);
    expect(activeTasks.has("t1")).toBe(false);
  });

  it("clears active on failure", async () => {
    const runner = new TaskRunner(db, async () => {
      throw new Error("mock failure");
    });

    runner.run("t1");
    await runner.waitFor("t1");
    
    const activeTasks = (runner as any).activeTasks;
    expect(activeTasks.has("t1")).toBe(false);
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("failed");
    expect(taskRecordsRepository(db).listEvents("t1").at(-1)?.type).toBe("task.failed");
  });

  it("notifies durable schedulers whenever task execution settles", async () => {
    const settled: string[] = [];
    const runner = new TaskRunner(db, async () => undefined);
    const unsubscribe = runner.onSettled((taskId) => settled.push(taskId));

    runner.run("t1");
    await runner.waitFor("t1");
    expect(settled).toEqual(["t1"]);

    unsubscribe();
    taskRepository(db).createTask({ id: "t2", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt: new Date().toISOString() });
    runner.run("t2");
    await runner.waitFor("t2");
    expect(settled).toEqual(["t1"]);
  });

  it("records failed agent state when an executor fails unexpectedly", async () => {
    const createdAt = new Date().toISOString();
    taskRepository(db).createTask({ id: "agent", projectId: "p1", kind: "agent_chat", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    records.transitionAgentState("agent", { id: "agent-idle", state: "idle", details: {}, createdAt });
    const runner = new TaskRunner(db, async () => {
      throw new Error("executor failure");
    });

    runner.run("agent");
    await runner.waitFor("agent");

    expect(records.getAgentState("agent")?.state).toBe("failed");
  });

  it("records cancelled agent state when a user cancels a running task", async () => {
    const createdAt = new Date().toISOString();
    taskRepository(db).createTask({ id: "agent", projectId: "p1", kind: "agent_chat", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    records.transitionAgentState("agent", { id: "agent-idle", state: "idle", details: {}, createdAt });
    const runner = new TaskRunner(db, async ({ abortSignal }) => {
      await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    runner.run("agent");
    runner.cancel("agent");

    expect(records.getAgentState("agent")?.state).toBe("cancelled");
  });

  it("persists mission-terminal cancellation only on the exact task tree", async () => {
    const createdAt = new Date().toISOString();
    taskRepository(db).createTask({ id: "root", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt });
    taskRepository(db).createTask({ id: "child", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt });
    taskRepository(db).createTask({ id: "sibling", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    const runner = new TaskRunner(db, async ({ taskId, abortSignal }) => {
      records.transitionTask(taskId, "running", { id: `${taskId}-running`, createdAt, payload: {} });
      await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    runner.run("root");
    runner.run("child");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    runner.cancel("root", "mission_terminal");
    await runner.waitFor("root");

    expect(records.listEvents("root").at(-1)?.payload).toMatchObject({ reason: "mission_terminal" });
    expect(records.listEvents("child").at(-1)?.payload).toMatchObject({ reason: "parent_cancelled" });
    expect(taskRepository(db).getTaskById("sibling")?.status).toBe("queued");
    expect(runner.isActive("root")).toBe(false);
    expect(runner.isActive("child")).toBe(false);
  });
});
