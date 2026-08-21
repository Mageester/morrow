import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { schedulesRepository } from "../src/repositories/schedules.js";
import { SchedulerTicker } from "../src/schedule/ticker.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import type { ScheduleNotificationEvent } from "@morrow/contracts";

describe("schedules repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: "2026-01-01T00:00:00.000Z" });
  });
  afterEach(() => db.close());

  it("returns only enabled, due schedules and advances on markRan", () => {
    const repo = schedulesRepository(db);
    repo.create({ id: "s1", projectId: "p1", cron: "*/15 * * * *", taskKind: "inspect_workspace", nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
    repo.create({ id: "s2", projectId: "p1", cron: "0 0 * * *", taskKind: "inspect_workspace", nextRunAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });

    expect(repo.due("2026-01-01T00:05:00.000Z").map((s) => s.id)).toEqual(["s1"]);
    repo.setEnabled("s1", false);
    expect(repo.due("2026-01-01T00:05:00.000Z")).toEqual([]);
    repo.setEnabled("s1", true);
    repo.markRan("s1", "2026-01-01T00:05:00.000Z", "2026-01-01T00:15:00.000Z");
    expect(repo.get("s1")?.nextRunAt).toBe("2026-01-01T00:15:00.000Z");
    expect(repo.due("2026-01-01T00:10:00.000Z")).toEqual([]);
  });
});

describe("SchedulerTicker", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: "2026-01-01T00:00:00.000Z" });
  });
  afterEach(() => db.close());

  it("fires one isolated task per due schedule and advances next_run_at", () => {
    const repo = schedulesRepository(db);
    repo.create({ id: "s1", projectId: "p1", cron: "*/15 * * * *", taskKind: "inspect_workspace", nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });

    let clock = new Date("2026-01-01T00:07:00.000Z");
    const ticker = new SchedulerTicker({ db, runner: new TaskRunner(db, async () => {}), now: () => clock });

    const fired = ticker.tick();
    expect(fired).toHaveLength(1);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    // next run is the next */15 boundary strictly after 00:07 → 00:15.
    expect(repo.get("s1")?.nextRunAt).toBe("2026-01-01T00:15:00.000Z");
    expect(repo.get("s1")?.lastRunAt).toBe("2026-01-01T00:07:00.000Z");

    // Not due again until the clock reaches the next boundary.
    expect(ticker.tick()).toHaveLength(0);
    clock = new Date("2026-01-01T00:15:30.000Z");
    expect(ticker.tick()).toHaveLength(1);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(2);
  });

  it("notifies configured adapters when a schedule fires", async () => {
    const repo = schedulesRepository(db);
    repo.create({ id: "s1", projectId: "p1", cron: "* * * * *", taskKind: "inspect_workspace", nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
    const sent: Array<{ text: string }> = [];
    const adapter = { id: "fake", channel: "webhook" as const, send: async (m: { text: string }) => { sent.push(m); return { ok: true, detail: "ok" }; } };
    const ticker = new SchedulerTicker({ db, runner: new TaskRunner(db, async () => {}), now: () => new Date("2026-01-01T00:01:00.000Z"), adapters: [adapter] });
    ticker.tick();
    // Notification is fire-and-forget; allow the microtask to settle.
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/scheduled task/i);
  });

  it("routes blocked routine notifications to the selected adapter with redacted generic text", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "blocked-routine",
      projectId: "p1",
      cron: "* * * * *",
      taskKind: "routine",
      routineId: "missing-routine",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["blocked"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const sent: Array<{ adapter: string; text: string }> = [];
    const adapters = (["webhook", "telegram"] as const).map((id) => ({
      id,
      channel: id,
      send: async (message: { text: string }) => {
        sent.push({ adapter: id, text: message.text });
        return { ok: true, detail: "ok" };
      },
    }));
    const ticker = new SchedulerTicker({
      db,
      runner: new TaskRunner(db, async () => {}),
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      adapters,
    });

    ticker.tick();
    await Promise.resolve();
    expect(repo.listRuns(schedule.id)[0]?.status).toBe("blocked");
    expect(sent).toEqual([{ adapter: "telegram", text: expect.stringMatching(/review its schedule history/i) }]);
    expect(sent[0]?.text).not.toMatch(/missing-routine|objective|output|secret/i);
  });

  it("retains a selected adapter outbox row while that adapter is temporarily unavailable", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "unavailable-adapter-routine",
      projectId: "p1",
      cron: "* * * * *",
      taskKind: "routine",
      routineId: "missing-routine",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["blocked"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const firstTicker = new SchedulerTicker({
      db,
      runner: new TaskRunner(db, async () => {}),
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      adapters: [],
    });
    firstTicker.tick();
    expect(db.prepare("SELECT status,attempts FROM schedule_notification_outbox WHERE schedule_run_id=?").get(repo.listRuns(schedule.id)[0]?.id)).toEqual({ status: "pending", attempts: 0 });

    const sent: string[] = [];
    const secondTicker = new SchedulerTicker({
      db,
      runner: { run: () => undefined, isActive: () => false },
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      adapters: [{ id: "telegram", channel: "telegram" as const, send: async (message: { text: string }) => { sent.push(message.text); return { ok: true, detail: "sent" }; } }],
    });
    secondTicker.tick();
    await Promise.resolve();
    expect(sent).toEqual(["Morrow scheduled routine run is blocked; review its schedule history."]);
    expect(db.prepare("SELECT status,attempts FROM schedule_notification_outbox WHERE schedule_run_id=?").get(repo.listRuns(schedule.id)[0]?.id)).toEqual({ status: "sent", attempts: 1 });
  });

  it("notifies once when a scheduled routine waits for approval", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "approval-routine",
      projectId: "p1",
      cron: "* * * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["waiting_for_approval"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const taskId = "approval-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "running", createdAt: "2026-01-01T00:00:00.000Z" });
    taskRecordsRepository(db).transitionAgentState(taskId, {
      id: "approval-idle", state: "idle", details: {}, createdAt: "2026-01-01T00:00:00.000Z",
    });
    taskRecordsRepository(db).transitionAgentState(taskId, {
      id: "approval-understanding", state: "understanding", details: {}, createdAt: "2026-01-01T00:00:00.000Z",
    });
    taskRecordsRepository(db).transitionAgentState(taskId, {
      id: "approval-planning", state: "planning", details: {}, createdAt: "2026-01-01T00:00:00.000Z",
    });
    taskRecordsRepository(db).transitionAgentState(taskId, {
      id: "approval-state", state: "waiting_for_approval", details: { approvalId: "approval-1" }, createdAt: "2026-01-01T00:00:00.000Z",
    });
    approvalsRepository(db).create({
      id: "approval-1", taskId, projectId: "p1", kind: "command", summary: "Approve command", details: { executable: "npm" }, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
    repo.markDispatched(run.id, taskId, "2026-01-01T00:00:00.000Z");
    // Simulate the normal dispatch boundary before the next ticker observes
    // the approval: the durable run may still be queued while the task has
    // already parked for approval.
    db.prepare("UPDATE schedule_runs SET status='queued' WHERE id=?").run(run.id);

    const sent: string[] = [];
    const adapters = (["webhook", "telegram"] as const).map((id) => ({
      id,
      channel: id,
      send: async (message: { text: string }) => {
        if (id === "telegram") sent.push(message.text);
        return { ok: true, detail: "ok" };
      },
    }));
    const ticker = new SchedulerTicker({ db, runner: { run: () => undefined, isActive: () => false }, now: () => new Date("2026-01-01T00:01:00.000Z"), adapters });
    ticker.tick();
    ticker.tick();
    await Promise.resolve();
    expect(sent).toEqual(["Morrow scheduled routine run is waiting for approval."]);
    expect(sent[0]).not.toMatch(/Approve command|npm|objective|output|secret/i);
  });

  it("retries a rejected adapter delivery and does not duplicate a successful outbox row", async () => {
    const repo = schedulesRepository(db);
    repo.create({
      id: "retry-routine",
      projectId: "p1",
      cron: "* * * * *",
      taskKind: "routine",
      routineId: "missing-routine",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["blocked"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    let attempts = 0;
    const adapter = {
      id: "telegram",
      channel: "telegram" as const,
      send: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, detail: "temporary rejection" } : { ok: true, detail: "sent" };
      },
    };
    const ticker = new SchedulerTicker({
      db,
      runner: new TaskRunner(db, async () => {}),
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      adapters: [adapter],
    });

    ticker.tick();
    await Promise.resolve();
    expect(attempts).toBe(1);
    ticker.tick();
    await Promise.resolve();
    expect(attempts).toBe(2);
    ticker.tick();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(db.prepare("SELECT status,attempts,last_error FROM schedule_notification_outbox WHERE adapter_id='telegram'").get()).toMatchObject({
      status: "sent",
      attempts: 2,
      last_error: null,
    });
  });

  it("hydrates a terminal linked task after restart before enqueueing its notification", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "restart-terminal-routine",
      projectId: "p1",
      cron: "0 23 * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-02T23:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["completed"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const taskId = "restart-terminal-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "completed", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" });
    const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
    repo.markDispatched(run.id, taskId, "2026-01-01T00:00:00.000Z");
    // Crash between task settlement and projection hydration leaves the run
    // non-terminal even though its linked task is complete.
    db.prepare("UPDATE schedule_runs SET status='queued' WHERE id=?").run(run.id);
    const sent: string[] = [];
    const ticker = new SchedulerTicker({
      db,
      runner: { run: () => undefined, isActive: () => false },
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      adapters: [{ id: "telegram", channel: "telegram" as const, send: async (message: { text: string }) => { sent.push(message.text); return { ok: true, detail: "sent" }; } }],
    });
    ticker.tick();
    await Promise.resolve();
    expect(repo.listRuns(schedule.id)[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(sent).toEqual(["Morrow scheduled routine run completed."]);
  });

  it("repairs upgrade-era failed runs linked to interrupted or running tasks without false failure notifications", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "upgrade-recovery-routine",
      projectId: "p1",
      cron: "0 23 * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-02T23:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["failed"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const taskIds = ["upgrade-interrupted-task", "upgrade-running-task"] as const;
    const statuses = ["interrupted", "running"] as const;
    const runIds: string[] = [];
    taskIds.forEach((taskId, index) => {
      taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: statuses[index]!, createdAt: "2026-01-01T00:00:00.000Z" });
      const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
      repo.markDispatched(run.id, taskId, "2026-01-01T00:00:00.000Z");
      db.prepare("UPDATE schedule_runs SET status='failed',error_code='STALE_FAILURE',error_message='stale failure',completed_at=?,notification_observed_event=NULL WHERE id=?")
        .run("2026-01-01T00:01:00.000Z", run.id);
      runIds.push(run.id);
    });
    const replayed: string[] = [];
    const sent: string[] = [];
    const ticker = new SchedulerTicker({
      db,
      runner: { run: (taskId: string) => replayed.push(taskId), isActive: () => false },
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      adapters: [{ id: "telegram", channel: "telegram" as const, send: async (message: { text: string }) => { sent.push(message.text); return { ok: true, detail: "sent" }; } }],
    });
    ticker.tick();
    expect(runIds.map((id) => db.prepare("SELECT status,error_code,error_message,completed_at FROM schedule_runs WHERE id=?").get(id))).toEqual([
      { status: "running", error_code: null, error_message: null, completed_at: null },
      { status: "running", error_code: null, error_message: null, completed_at: null },
    ]);
    expect(repo.listRuns(schedule.id).filter((run) => runIds.includes(run.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "running", errorCode: null, errorMessage: null, completedAt: null }),
      expect.objectContaining({ status: "running", errorCode: null, errorMessage: null, completedAt: null }),
    ]));
    expect(replayed).toEqual(["upgrade-interrupted-task"]);
    expect(sent).toEqual([]);
  });

  it("rehydrates a terminal task even when a prior nonterminal observation was already recorded", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "observed-terminal-routine",
      projectId: "p1",
      cron: "0 23 * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-02T23:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["completed"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    const taskId = "observed-terminal-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "running", createdAt: "2026-01-01T00:00:00.000Z" });
    const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
    repo.markDispatched(run.id, taskId, "2026-01-01T00:00:00.000Z");
    db.prepare("UPDATE schedule_runs SET status='running',notification_observed_event='none' WHERE id=?").run(run.id);
    taskRepository(db).updateTaskStatus(taskId, { status: "completed", updatedAt: "2026-01-01T00:01:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" });
    const sent: string[] = [];
    const ticker = new SchedulerTicker({
      db,
      runner: { run: () => undefined, isActive: () => false },
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      adapters: [{ id: "telegram", channel: "telegram" as const, send: async (message: { text: string }) => { sent.push(message.text); return { ok: true, detail: "sent" }; } }],
    });
    ticker.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repo.listRuns(schedule.id)[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(sent).toEqual(["Morrow scheduled routine run completed."]);
  });

  it("advances notification observation past more than one bounded page of terminal runs", async () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "large-notification-routine",
      projectId: "p1",
      cron: "0 23 * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-02T23:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      notification: { events: ["blocked"] as ScheduleNotificationEvent[], adapterId: "telegram" },
    });
    for (let index = 0; index < 501; index += 1) {
      const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
      repo.markBlocked(run.id, "ROUTINE_BLOCKED", "blocked", "2026-01-01T00:00:00.000Z");
    }
    const sent: string[] = [];
    const adapter = { id: "telegram", channel: "telegram" as const, send: async (message: { text: string }) => { sent.push(message.text); return { ok: true, detail: "sent" }; } };
    const ticker = new SchedulerTicker({
      db,
      runner: { run: () => undefined, isActive: () => false },
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      adapters: [adapter],
    });
    ticker.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(100);
    expect(db.prepare("SELECT count(*) AS count FROM schedule_runs WHERE notification_observed_event IS NOT NULL AND schedule_id=?").get(schedule.id)).toEqual({ count: 500 });
    ticker.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(db.prepare("SELECT count(*) AS count FROM schedule_runs WHERE notification_observed_event IS NOT NULL AND schedule_id=?").get(schedule.id)).toEqual({ count: 501 });
    expect(db.prepare("SELECT count(*) AS count FROM schedule_notification_outbox WHERE schedule_run_id IN (SELECT id FROM schedule_runs WHERE schedule_id=?)").get(schedule.id)).toEqual({ count: 501 });
    for (let page = 0; page < 4; page += 1) {
      ticker.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).toHaveLength(501);
  });

  it("does not terminalize a running or interrupted task from a settlement callback", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "recovery-routine",
      projectId: "p1",
      cron: "0 23 * * *",
      taskKind: "routine",
      routineId: "routine-1",
      nextRunAt: "2026-01-02T23:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const taskId = "recovery-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "interrupted", createdAt: "2026-01-01T00:00:00.000Z" });
    const run = repo.createManualRun({ schedule, occurrenceAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
    repo.markDispatched(run.id, taskId, "2026-01-01T00:00:00.000Z");
    let settled!: (taskId: string) => void;
    const ticker = new SchedulerTicker({
      db,
      runner: { run: () => undefined, onSettled: (listener: (taskId: string) => void) => { settled = listener; return () => undefined; } },
      now: () => new Date("2026-01-01T00:02:00.000Z"),
    });
    settled(taskId);
    expect(repo.listRuns(schedule.id)[0]).toMatchObject({ status: "running", completedAt: null });
    ticker.stop();
  });
});

describe("schedules API", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("creates, lists, runs, and deletes a schedule", async () => {
    const create = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 9 * * 1-5" } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    expect(create.json().nextRunAt).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/schedules" });
    expect(list.json().map((s: any) => s.id)).toEqual([id]);

    const run = await app.inject({ method: "POST", url: `/api/schedules/${id}/run`, payload: { projectId: "p1" } });
    expect(run.statusCode).toBe(202);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);

    const del = await app.inject({ method: "DELETE", url: `/api/schedules/${id}`, payload: { projectId: "p1" } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/schedules" })).json()).toEqual([]);
  });

  it("rejects an invalid cron expression with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "not a cron" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("404s scheduling under an unknown project", async () => {
    expect((await app.inject({ method: "POST", url: "/api/projects/nope/schedules", payload: { cron: "* * * * *" } })).statusCode).toBe(404);
  });

  it("persists a safe notification policy and exposes only configured adapters", async () => {
    const agent = await app.inject({
      method: "POST",
      url: "/api/projects/p1/agents",
      payload: { name: "Notifier", role: "writer" },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const routine = await app.inject({
      method: "POST",
      url: "/api/projects/p1/routines",
      payload: { name: "Notify routine", objective: "Report completion.", steps: [], agentId: agent.json().id },
    });
    expect(routine.statusCode, routine.body).toBe(201);
    app.close();
    app = buildServer({
      db,
      runner: new TaskRunner(db, async () => {}),
      messageAdapters: [
        { id: "webhook", channel: "webhook", send: async () => ({ ok: true, detail: "ok" }) },
        { id: "telegram", channel: "telegram", send: async () => ({ ok: true, detail: "ok" }) },
      ],
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/p1/schedules",
      payload: {
        cron: "0 9 * * 1-5",
        routineId: routine.json().id,
        notification: { events: ["waiting_for_approval", "blocked"], adapterId: "telegram" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().notification).toEqual({
      events: ["waiting_for_approval", "blocked"],
      adapterId: "telegram",
    });

    const options = await app.inject({ method: "GET", url: "/api/projects/p1/schedule-notification-options" });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({
      version: 1,
      projectId: "p1",
      adapters: [
        { id: "webhook", channel: "webhook" },
        { id: "telegram", channel: "telegram" },
      ],
    });

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/projects/p1/schedules/${created.json().id}`,
      payload: { notification: { adapterId: "missing" } },
    });
    expect(rejected.statusCode).toBe(400);

    const converted = await app.inject({
      method: "PATCH",
      url: `/api/projects/p1/schedules/${created.json().id}`,
      payload: { taskKind: "inspect_workspace" },
    });
    expect(converted.statusCode, converted.body).toBe(200);
    expect(converted.json().notification).toEqual({ events: ["completed", "failed", "blocked"], adapterId: null });
  });

  it("rejects notification policy on legacy inspect schedules instead of ignoring it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/schedules",
      payload: { cron: "0 9 * * *", notification: { events: ["completed"] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NOTIFICATION_UNSUPPORTED_FOR_TASK_KIND");
  });
});
