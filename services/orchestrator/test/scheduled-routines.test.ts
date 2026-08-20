import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { schedulesRepository } from "../src/repositories/schedules.js";
import { SchedulerTicker } from "../src/schedule/ticker.js";
import { routinesRepository } from "../src/repositories/routines.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { ScheduleRunSchema } from "@morrow/contracts";

const NOW = "2026-08-20T10:00:00.000Z";

describe("durable scheduled routines", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildServer>;
  let agentId: string;
  let routineId: string;

  beforeEach(async () => {
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: NOW });
    app = buildServer({ db, runner: new TaskRunner(db, async () => undefined) });
    agentId = (await app.inject({
      method: "POST", url: "/api/projects/p1/agents", payload: { name: "Reporter", role: "writer" },
    })).json().id;
    routineId = (await app.inject({
      method: "POST", url: "/api/projects/p1/routines", payload: {
        name: "Weekly report", objective: "Summarise this week.", steps: [], agentId,
      },
    })).json().id;
  });

  afterEach(() => {
    app.close();
    db.close();
    delete process.env.MOCK_PROVIDER;
  });

  it("binds a schedule to a same-project enabled standalone teammate and routine", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/projects/p1/schedules",
      payload: { cron: "*/15 * * * *", routineId },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ taskKind: "routine", routineId, agentId, enabled: true });
  });

  it("claims one durable occurrence, coalesces missed ticks, and never duplicates it", async () => {
    const schedule = schedulesRepository(db).create({
      id: "s1", projectId: "p1", cron: "*/15 * * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-20T09:00:00.000Z", createdAt: NOW,
    });
    let clock = new Date("2026-08-20T10:00:00.000Z");
    const runner = new TaskRunner(db, async () => undefined);
    const ticker = new SchedulerTicker({ db, runner, now: () => clock });

    const fired = ticker.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ scheduleId: schedule.id, routineId, coalesced: true });
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    expect(schedulesRepository(db).get(schedule.id)?.nextRunAt).toBe("2026-08-20T10:15:00.000Z");

    const again = ticker.tick();
    expect(again).toEqual([]);
    const runs = schedulesRepository(db).listRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.occurrenceAt).toBe("2026-08-20T09:00:00.000Z");
    expect(runs[0]?.taskId).toBe(fired[0]?.taskId);
    expect(ScheduleRunSchema.parse(runs[0])).toBeTruthy();
    expect(routinesRepository(db).get(routineId)?.runCount).toBe(1);
  });

  it("forces scheduled routine dispatch to require approval and exposes history", async () => {
    const schedule = (await app.inject({
      method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "* * * * *", routineId },
    })).json();
    const run = await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/run`, payload: { projectId: "p1" } });
    expect(run.statusCode, run.body).toBe(202);
    const task = taskRepository(db).getTaskById(run.json().taskId)!;
    const routing = db.prepare("SELECT decision_json FROM task_routing WHERE task_id=?").get(task.id) as { decision_json: string };
    expect(JSON.parse(routing.decision_json).autoApprove).toBe(false);

    const history = await app.inject({ method: "GET", url: `/api/schedules/${schedule.id}/runs?projectId=p1` });
    expect(history.statusCode).toBe(200);
    expect(history.json()[0]).toMatchObject({ trigger: "manual", taskId: task.id });
  });

  it("reconciles a claimed occurrence after a dispatch boundary without duplicating the task", () => {
    const repo = schedulesRepository(db);
    repo.create({
      id: "crash-schedule", projectId: "p1", cron: "*/15 * * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-20T09:00:00.000Z", createdAt: NOW,
    });
    const schedule = repo.get("crash-schedule")!;
    const claim = repo.claimScheduledOccurrence({
      schedule,
      occurrenceAt: schedule.nextRunAt,
      nextRunAt: "2026-08-20T10:15:00.000Z",
      now: "2026-08-20T10:00:00.000Z",
      coalesced: true,
    });
    expect(claim?.claimed).toBe(true);

    const ticker = new SchedulerTicker({
      db,
      runner: new TaskRunner(db, async () => undefined),
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const recovered = ticker.tick();
    expect(recovered).toHaveLength(1);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    expect(repo.listRuns("crash-schedule")[0]?.status).toBe("queued");
  });

  it("requeues an interrupted scheduled task after restart without terminalizing its run", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "restart-schedule", projectId: "p1", cron: "0 23 * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-21T23:00:00.000Z", createdAt: NOW,
    });
    const taskId = "restart-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "interrupted", createdAt: NOW });
    const run = repo.createManualRun({ schedule, occurrenceAt: NOW, now: NOW });
    repo.markDispatched(run.id, taskId, NOW);
    const calls: Array<{ taskId: string; recovered?: boolean }> = [];
    const ticker = new SchedulerTicker({
      db,
      runner: {
        run: (id: string, options?: { recovered?: boolean }) => { calls.push({ taskId: id, ...(options ?? {}) }); },
        isActive: () => false,
      },
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });

    expect(ticker.tick()).toEqual([]);
    expect(calls).toEqual([{ taskId, recovered: true }]);
    expect(ticker.tick()).toEqual([]);
    expect(calls).toEqual([{ taskId, recovered: true }]);
    expect(repo.listRuns(schedule.id)[0]).toMatchObject({ status: "running", completedAt: null });
  });

  it("does not replay a claimed recovery after process restart until its lease expires", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "lease-schedule", projectId: "p1", cron: "0 23 * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-21T23:00:00.000Z", createdAt: NOW,
    });
    const taskId = "lease-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "interrupted", createdAt: NOW });
    const run = repo.createManualRun({ schedule, occurrenceAt: NOW, now: NOW });
    repo.markDispatched(run.id, taskId, NOW);

    const first = repo.claimRecoverableRun({ id: run.id, owner: "scheduler:first", now: NOW, leaseExpiresAt: "2026-08-20T10:05:00.000Z" });
    expect(first).toBeTruthy();
    expect(repo.claimRecoverableRun({ id: run.id, owner: "scheduler:second", now: NOW, leaseExpiresAt: "2026-08-20T10:10:00.000Z" })).toBeUndefined();
    expect(repo.claimRecoverableRun({ id: run.id, owner: "scheduler:second", now: "2026-08-20T10:05:00.000Z", leaseExpiresAt: "2026-08-20T10:10:00.000Z" })).toBeTruthy();
  });

  it("keeps a restarted ticker fenced after crash-after-claim, then permits expiry recovery", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "lease-ticker-schedule", projectId: "p1", cron: "0 23 * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-21T23:00:00.000Z", createdAt: NOW,
    });
    const taskId = "lease-ticker-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "interrupted", createdAt: NOW });
    const run = repo.createManualRun({ schedule, occurrenceAt: NOW, now: NOW });
    repo.markDispatched(run.id, taskId, NOW);
    expect(repo.claimRecoverableRun({ id: run.id, owner: "scheduler:crashed", now: NOW, leaseExpiresAt: "2026-08-20T10:05:00.000Z" })).toBeTruthy();

    let clock = new Date(NOW);
    const calls: string[] = [];
    const restarted = () => new SchedulerTicker({
      db,
      runner: { run: (id: string) => calls.push(id), isActive: () => false },
      now: () => clock,
    });
    expect(restarted().tick()).toEqual([]);
    expect(calls).toEqual([]);

    clock = new Date("2026-08-20T10:05:00.000Z");
    expect(restarted().tick()).toEqual([]);
    expect(calls).toEqual([taskId]);
    repo.markTaskSettled(taskId, "completed", clock.toISOString());
    expect(db.prepare("SELECT recovery_owner,recovery_lease_expires_at,recovery_attempts FROM schedule_runs WHERE id=?").get(run.id)).toMatchObject({
      recovery_owner: null,
      recovery_lease_expires_at: null,
      recovery_attempts: 2,
    });
  });

  it("clears a stale recovery lease when the settlement listener sees an already-terminal run", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "settled-lease-schedule", projectId: "p1", cron: "0 23 * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-21T23:00:00.000Z", createdAt: NOW,
    });
    const taskId = "settled-lease-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "completed", createdAt: NOW, completedAt: NOW });
    const run = repo.createManualRun({ schedule, occurrenceAt: NOW, now: NOW });
    repo.markDispatched(run.id, taskId, NOW);
    db.prepare(
      "UPDATE schedule_runs SET status='completed',completed_at=?,recovery_owner=?,recovery_lease_expires_at=? WHERE id=?",
    ).run(NOW, "scheduler:stale", "2026-08-20T10:05:00.000Z", run.id);

    let settled!: (id: string) => void;
    const ticker = new SchedulerTicker({
      db,
      runner: {
        run: () => undefined,
        onSettled: (listener: (id: string) => void) => {
          settled = listener;
          return () => undefined;
        },
      },
      now: () => new Date(NOW),
    });
    settled(taskId);
    expect(db.prepare("SELECT recovery_owner,recovery_lease_expires_at FROM schedule_runs WHERE id=?").get(run.id)).toEqual({
      recovery_owner: null,
      recovery_lease_expires_at: null,
    });
    ticker.stop();
  });

  it("keeps a pending-approval scheduled run visibly waiting across hydration", () => {
    const repo = schedulesRepository(db);
    const schedule = repo.create({
      id: "approval-schedule", projectId: "p1", cron: "0 23 * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-21T23:00:00.000Z", createdAt: NOW,
    });
    const taskId = "approval-task";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "running", createdAt: NOW });
    const records = taskRecordsRepository(db);
    records.transitionAgentState(taskId, { id: "idle", state: "idle", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "understanding", state: "understanding", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "planning", state: "planning", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "waiting", state: "waiting_for_approval", details: { approvalId: "approval-1" }, createdAt: NOW });
    approvalsRepository(db).create({
      id: "approval-1", taskId, projectId: "p1", kind: "command", summary: "Approve command", details: { executable: "npm" }, createdAt: NOW,
    });
    const run = repo.createManualRun({ schedule, occurrenceAt: NOW, now: NOW });
    repo.markDispatched(run.id, taskId, NOW);

    expect(repo.listRuns(schedule.id)[0]).toMatchObject({ status: "waiting_for_approval", completedAt: null });
    expect(db.prepare("SELECT status FROM schedule_runs WHERE id=?").get(run.id)).toEqual({ status: "waiting_for_approval" });
    const calls: string[] = [];
    const ticker = new SchedulerTicker({ db, runner: { run: (task: string) => calls.push(task), isActive: () => false }, now: () => new Date("2026-08-20T10:00:00.000Z") });
    ticker.tick();
    expect(calls).toEqual([]);
  });

  it("restarts a parked approval task only after the approval is resolved", async () => {
    const taskId = "approval-restart-route";
    taskRepository(db).createTask({ id: taskId, projectId: "p1", kind: "agent_chat", status: "running", createdAt: NOW });
    const records = taskRecordsRepository(db);
    records.transitionAgentState(taskId, { id: "route-idle", state: "idle", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "route-understanding", state: "understanding", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "route-planning", state: "planning", details: {}, createdAt: NOW });
    records.transitionAgentState(taskId, { id: "route-waiting", state: "waiting_for_approval", details: { approvalId: "route-approval" }, createdAt: NOW });
    approvalsRepository(db).create({
      id: "route-approval", taskId, projectId: "p1", kind: "command", summary: "Approve command", details: { executable: "npm" }, createdAt: NOW,
    });

    const resolved = await app.inject({
      method: "POST", url: "/api/approvals/route-approval/resolve",
      payload: { projectId: "p1", decision: "allow_once" },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(taskRepository(db).getTaskById(taskId)?.status).toBe("queued");
    expect(records.listEvents(taskId).map((event) => event.type)).toContain("task.recovery_requeued");
  });

  it("pauses, edits, and deletes a routine schedule without changing legacy inspect schedules", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 9 * * *", routineId },
    });
    const id = created.json().id;
    const paused = await app.inject({ method: "PATCH", url: `/api/projects/p1/schedules/${id}`, payload: { enabled: false } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().enabled).toBe(false);
    const edited = await app.inject({ method: "PATCH", url: `/api/projects/p1/schedules/${id}`, payload: { cron: "0 10 * * *", enabled: true } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().cron).toBe("0 10 * * *");

    const legacy = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 12 * * *" } });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.json()).toMatchObject({ taskKind: "inspect_workspace", routineId: null });
    const deleted = await app.inject({ method: "DELETE", url: `/api/schedules/${id}`, payload: { projectId: "p1" } });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/schedules/${id}/runs?projectId=p1` })).json()).toEqual([]);
  });

  it("blocks disabled or team teammates at schedule creation and execution", async () => {
    await app.inject({ method: "PUT", url: `/api/agents/${agentId}`, payload: { projectId: "p1", enabled: false } });
    const disabled = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "* * * * *", routineId } });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error.code).toBe("AGENT_DISABLED");

    const restored = await app.inject({ method: "PUT", url: `/api/agents/${agentId}`, payload: { projectId: "p1", enabled: true } });
    expect(restored.statusCode).toBe(200);
    const schedule = schedulesRepository(db).create({
      id: "disabled-at-fire", projectId: "p1", cron: "* * * * *", taskKind: "routine", routineId, agentId,
      nextRunAt: "2026-08-20T09:00:00.000Z", createdAt: NOW,
    });
    const disabledAgain = await app.inject({ method: "PUT", url: `/api/agents/${agentId}`, payload: { projectId: "p1", enabled: false } });
    expect(disabledAgain.statusCode).toBe(200);
    const ticker = new SchedulerTicker({
      db,
      runner: new TaskRunner(db, async () => undefined),
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    expect(ticker.tick()).toEqual([]);
    expect(schedulesRepository(db).listRuns(schedule.id)[0]).toMatchObject({ status: "blocked", errorCode: "AGENT_DISABLED" });
  });

  it("requires matching project ownership on every id-addressed schedule alias", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 9 * * *", routineId } });
    const schedule = schedulesRepository(db).listByProject("p1").find((item) => item.routineId === routineId)!;
    const omitted = [
      await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/pause`, payload: {} }),
      await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/resume`, payload: {} }),
      await app.inject({ method: "PATCH", url: `/api/schedules/${schedule.id}`, payload: { cron: "0 10 * * *" } }),
      await app.inject({ method: "GET", url: `/api/schedules/${schedule.id}/runs` }),
      await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/run`, payload: {} }),
      await app.inject({ method: "DELETE", url: `/api/schedules/${schedule.id}`, payload: {} }),
    ];
    expect(omitted.map((response) => response.statusCode)).toEqual([400, 400, 400, 400, 400, 400]);

    await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 10 * * *", routineId } });
    const otherSchedule = schedulesRepository(db).listByProject("p1").find((item) => item.id !== schedule.id && item.routineId === routineId)!;
    const crossProject = [
      await app.inject({ method: "POST", url: `/api/schedules/${otherSchedule.id}/pause`, payload: { projectId: "p2" } }),
      await app.inject({ method: "POST", url: `/api/schedules/${otherSchedule.id}/resume`, payload: { projectId: "p2" } }),
      await app.inject({ method: "PATCH", url: `/api/schedules/${otherSchedule.id}`, payload: { projectId: "p2", cron: "0 11 * * *" } }),
      await app.inject({ method: "GET", url: `/api/schedules/${otherSchedule.id}/runs?projectId=p2` }),
      await app.inject({ method: "POST", url: `/api/schedules/${otherSchedule.id}/run`, payload: { projectId: "p2" } }),
      await app.inject({ method: "DELETE", url: `/api/schedules/${otherSchedule.id}`, payload: { projectId: "p2" } }),
    ];
    expect(crossProject.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
  });
});
