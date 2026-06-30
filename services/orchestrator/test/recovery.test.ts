import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { recoverRunningTasks, reconcileTasksOnStartup, type ReconcilableRunner } from "../src/recovery.js";
import { TaskRunner } from "../src/runner.js";

const now = "2026-01-01T00:00:00.000Z";

/** Records dispatches without executing; mirrors the real runner's active-set
 *  duplicate guard so idempotency can be asserted deterministically. */
class FakeRunner implements ReconcilableRunner {
  readonly active = new Set<string>();
  readonly calls: { taskId: string; recovered: boolean }[] = [];
  run(taskId: string, opts: { recovered?: boolean } = {}): void {
    if (this.active.has(taskId)) throw new Error("Duplicate execution rejected");
    this.active.add(taskId);
    this.calls.push({ taskId, recovered: !!opts.recovered });
  }
  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }
}

describe("restart recovery", () => {
  it("interrupts running tasks once and leaves other task states intact", () => {
    const db = openDatabase(":memory:"); const projects = projectRepository(db); const tasks = taskRepository(db);
    projects.createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt: now });
    for (const [id, status] of [["running", "running"], ["queued", "queued"], ["verified", "verified"], ["failed", "failed"], ["interrupted", "interrupted"]] as const) tasks.createTask({ id, projectId: "p", kind: "inspect_workspace", status, createdAt: now });
    const records = taskRecordsRepository(db);
    records.appendEvent({ id: "old", taskId: "running", type: "task.created", payload: {}, createdAt: now });
    expect(recoverRunningTasks(db, records, now)).toBe(1);
    expect(records.getAggregate("running").task.status).toBe("interrupted");
    expect(records.listEvents("running").map((event) => event.type)).toEqual(["task.created", "task.interrupted", "task.recovery_required"]);
    expect(recoverRunningTasks(db, records, now)).toBe(0);
    for (const id of ["queued", "verified", "failed", "interrupted"]) expect(records.getAggregate(id).task.status).toBe(id);
    db.close();
  });

  it("only interrupts queued or streaming messages tied to recovered tasks", () => {
    const db = openDatabase(":memory:");
    const projects = projectRepository(db);
    const tasks = taskRepository(db);
    const convs = conversationsRepository(db);
    const records = taskRecordsRepository(db);

    projects.createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt: now });
    tasks.createTask({ id: "running", projectId: "p", kind: "agent_chat", status: "running", createdAt: now });
    tasks.createTask({ id: "queued", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
    convs.createConversation({ id: "c1", projectId: "p", title: "one", createdAt: now, updatedAt: now });
    convs.createConversation({ id: "c2", projectId: "p", title: "two", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "m1", conversationId: "c1", role: "assistant", content: "", taskId: "running", streamingState: "streaming", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "m2", conversationId: "c2", role: "assistant", content: "", taskId: "queued", streamingState: "queued", createdAt: now, updatedAt: now });

    expect(recoverRunningTasks(db, records, now)).toBe(1);
    expect(convs.getMessage("m1")?.streamingState).toBe("interrupted");
    expect(convs.getMessage("m2")?.streamingState).toBe("queued");
    db.close();
  });
});

describe("startup reconciliation", () => {
  const seedProject = (db: ReturnType<typeof openDatabase>) =>
    projectRepository(db).createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt: now });

  it("interrupts running tasks and re-dispatches orphaned queued tasks (no duplicate execution)", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    const tasks = taskRepository(db);
    tasks.createTask({ id: "run", projectId: "p", kind: "agent_chat", status: "running", createdAt: now });
    tasks.createTask({ id: "q1", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt: now });
    tasks.createTask({ id: "done", projectId: "p", kind: "inspect_workspace", status: "verified", createdAt: now });
    const records = taskRecordsRepository(db);
    const runner = new FakeRunner();

    const summary = reconcileTasksOnStartup({ db, runner, records, now: () => now });

    expect(summary).toEqual({ interrupted: 1, requeued: 1, cancelledOrphans: 0 });
    expect(records.getAggregate("run").task.status).toBe("interrupted");
    expect(records.getAggregate("done").task.status).toBe("verified");
    // The orphaned queued task is re-dispatched as a recovery, not a fresh create.
    expect(runner.calls).toEqual([{ taskId: "q1", recovered: true }]);
    db.close();
  });

  it("re-dispatches a queued subagent child whose parent is being recovered", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    const tasks = taskRepository(db);
    tasks.createTask({ id: "parent", projectId: "p", kind: "agent_chat", status: "running", createdAt: now });
    tasks.createTask({ id: "child", projectId: "p", kind: "inspect_workspace", status: "queued", parentTaskId: "parent", createdAt: now });
    const runner = new FakeRunner();

    const summary = reconcileTasksOnStartup({ db, runner, records: taskRecordsRepository(db), now: () => now });

    // Parent (running -> interrupted) counts as active, so the child resumes.
    expect(summary).toEqual({ interrupted: 1, requeued: 1, cancelledOrphans: 0 });
    expect(runner.calls.map((c) => c.taskId)).toEqual(["child"]);
    db.close();
  });

  it("cancels a queued subagent orphan whose parent already reached a terminal state", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db);
    tasks.createTask({ id: "parent", projectId: "p", kind: "inspect_workspace", status: "cancelled", createdAt: now });
    tasks.createTask({ id: "child", projectId: "p", kind: "inspect_workspace", status: "queued", parentTaskId: "parent", createdAt: now });
    const runner = new FakeRunner();

    const summary = reconcileTasksOnStartup({ db, runner, records, now: () => now });

    expect(summary).toEqual({ interrupted: 0, requeued: 0, cancelledOrphans: 1 });
    expect(records.getAggregate("child").task.status).toBe("cancelled");
    expect(runner.calls).toEqual([]); // orphan is never run
    const childEvents = records.listEvents("child").map((e) => e.type);
    expect(childEvents).toContain("task.cancelled");
    db.close();
  });

  it("is idempotent: a second reconciliation neither re-interrupts nor re-dispatches", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    const tasks = taskRepository(db);
    tasks.createTask({ id: "run", projectId: "p", kind: "agent_chat", status: "running", createdAt: now });
    tasks.createTask({ id: "q1", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt: now });
    const runner = new FakeRunner();

    const first = reconcileTasksOnStartup({ db, runner, records: taskRecordsRepository(db), now: () => now });
    const second = reconcileTasksOnStartup({ db, runner, records: taskRecordsRepository(db), now: () => now });

    expect(first).toEqual({ interrupted: 1, requeued: 1, cancelledOrphans: 0 });
    // `run` is already interrupted; `q1` is still queued in the fake but active,
    // so the duplicate guard skips it — exactly once-dispatched overall.
    expect(second).toEqual({ interrupted: 0, requeued: 0, cancelledOrphans: 0 });
    expect(runner.calls).toEqual([{ taskId: "q1", recovered: true }]);
    db.close();
  });

  it("end-to-end: an orphaned deterministic task resumes and completes after a simulated restart", async () => {
    const work = mkdtempSync(join(tmpdir(), "morrow-reconcile-"));
    writeFileSync(join(work, "readme.txt"), "hello");
    const db = openDatabase(":memory:");
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: work, createdAt: ts });
    const tasks = taskRepository(db);
    // Pre-crash state: one task mid-flight (running), one never started (queued).
    tasks.createTask({ id: "midflight", projectId: "p", kind: "inspect_workspace", status: "running", createdAt: ts });
    tasks.createTask({ id: "orphan", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt: ts });

    // Simulate process restart: new runner, then reconcile.
    const runner = new TaskRunner(db);
    try {
      const summary = reconcileTasksOnStartup({ db, runner });
      expect(summary.interrupted).toBe(1);
      expect(summary.requeued).toBe(1);

      await runner.waitFor("orphan");

      const records = taskRecordsRepository(db);
      // The mid-flight task is surfaced for a user decision, not silently lost.
      expect(records.getAggregate("midflight").task.status).toBe("interrupted");
      // The orphaned queued task actually executed to completion after restart.
      expect(records.getAggregate("orphan").task.status).toBe("verified");
      // Re-dispatch was recorded as a recovery, and execution ran exactly once.
      const orphanEvents = records.listEvents("orphan").map((e) => e.type);
      expect(orphanEvents).toContain("task.recovery_requeued");
      expect(orphanEvents).not.toContain("task.created");
      expect(orphanEvents.filter((t) => t === "task.running")).toHaveLength(1);
    } finally {
      db.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not re-dispatch or disturb cancelled or interrupted tasks", () => {
    const db = openDatabase(":memory:");
    seedProject(db);
    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db);
    tasks.createTask({ id: "cancelled", projectId: "p", kind: "inspect_workspace", status: "cancelled", createdAt: now });
    tasks.createTask({ id: "interrupted", projectId: "p", kind: "inspect_workspace", status: "interrupted", createdAt: now });
    const runner = new FakeRunner();

    const summary = reconcileTasksOnStartup({ db, runner, records, now: () => now });

    // Neither status is `queued`/`running`, so reconciliation must ignore both:
    // a cancelled task is never resurrected and an interrupted task is never
    // auto-resumed (it awaits an explicit user resume/retry).
    expect(summary).toEqual({ interrupted: 0, requeued: 0, cancelledOrphans: 0 });
    expect(runner.calls).toEqual([]);
    expect(records.getAggregate("cancelled").task.status).toBe("cancelled");
    expect(records.getAggregate("interrupted").task.status).toBe("interrupted");
    db.close();
  });

  it("end-to-end: re-dispatches an agent task that crashed mid-startup (stale agent-state) and runs it clean to completion", async () => {
    const prevMock = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    const work = mkdtempSync(join(tmpdir(), "morrow-reconcile-agent-"));
    writeFileSync(join(work, "evidence.txt"), "all systems nominal");
    const db = openDatabase(":memory:");
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: work, createdAt: ts });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c1", projectId: "p", title: "C", createdAt: ts, updatedAt: ts });
    convs.appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "agent", projectId: "p", kind: "agent_chat", status: "queued", createdAt: ts });
    convs.appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "agent", streamingState: "queued", createdAt: ts, updatedAt: ts });

    // Simulate a hard kill that landed after the agent advanced its state to
    // `planning` but before persisting `queued -> running`: the task is still
    // `queued` yet carries a stale agent-state chain that, untouched, would make
    // the fresh run throw on `planning -> understanding`.
    const records = taskRecordsRepository(db);
    for (const state of ["idle", "understanding", "planning"] as const) {
      records.transitionAgentState("agent", { id: randomUUID(), state, details: {}, createdAt: ts });
    }
    records.replacePlan("agent", [{ id: randomUUID(), position: 1, title: "stale", description: "stale", status: "running" }]);

    const runner = new TaskRunner(db);
    try {
      const summary = reconcileTasksOnStartup({ db, runner });
      expect(summary.requeued).toBe(1);
      await runner.waitFor("agent");

      // Clean restart: completes instead of failing on a stale-state collision.
      expect(taskRepository(db).getTaskById("agent")?.status).toBe("completed");
      expect(records.listEvents("agent").map((e) => e.type)).not.toContain("task.failed");
    } finally {
      db.close();
      rmSync(work, { recursive: true, force: true });
      if (prevMock === undefined) delete process.env.MOCK_PROVIDER; else process.env.MOCK_PROVIDER = prevMock;
    }
  });
});
