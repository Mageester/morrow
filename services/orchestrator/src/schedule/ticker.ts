import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Schedule, ScheduleRun } from "@morrow/contracts";
import type { TaskRunner } from "../runner.js";
import { schedulesRepository } from "../repositories/schedules.js";
import { taskRepository } from "../repositories/tasks.js";
import { routinesRepository } from "../repositories/routines.js";
import { nextRun } from "./cron.js";
import { notifyAll, type MessageAdapter } from "../messaging/adapter.js";
import { AgentTaskDispatchError } from "../mission/task-dispatcher.js";
import { assertRoutineTarget, dispatchRoutineTask } from "../routines/dispatch.js";

export interface FiredSchedule {
  scheduleId: string;
  taskId: string;
  nextRunAt: string;
  runId?: string;
  routineId?: string | null;
  occurrenceAt?: string;
  coalesced?: boolean;
}

type RunnerLike = Pick<TaskRunner, "run"> & Partial<Pick<TaskRunner, "onSettled" | "isActive">>;

/**
 * Drives the one Morrow cron scheduler. Legacy inspect-workspace rows keep
 * their original path; routine rows claim a durable occurrence first, then
 * use the same agent dispatcher as an interactive run.
 */
export class SchedulerTicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly recoveryOwner = `scheduler:${randomUUID()}`;
  private readonly unsubscribeSettled?: () => void;

  constructor(private readonly deps: {
    db: Database.Database;
    runner: RunnerLike;
    now?: () => Date;
    recoveryLeaseMs?: number;
    adapters?: MessageAdapter[];
    env?: NodeJS.ProcessEnv;
  }) {
    this.now = deps.now ?? (() => new Date());
    if (deps.runner.onSettled) {
      this.unsubscribeSettled = deps.runner.onSettled((taskId) => this.onTaskSettled(taskId));
    }
  }

  private notify(message: { subject: string; text: string }): void {
    if (!this.deps.adapters?.length) return;
    void notifyAll(this.deps.adapters, message).catch(() => {
      // Notification is an optional side effect and never changes run truth.
    });
  }

  private onTaskSettled(taskId: string): void {
    const schedules = schedulesRepository(this.deps.db);
    const run = schedules.getRunByTaskId(taskId);
    if (!run || run.trigger !== "scheduled" && run.trigger !== "manual") return;
    const task = taskRepository(this.deps.db).getTaskById(taskId);
    if (!task) return;
    const settled = schedules.markTaskSettled(taskId, task.status, this.now().toISOString());
    if (!settled || settled.routineId === null) return;
    const status = settled.status === "verified" || settled.status === "completed" ? "completed" : settled.status;
    this.notify({ subject: "Scheduled routine", text: `Morrow scheduled routine run ${status}.` });
  }

  private dispatchRoutineRun(input: {
    schedule: Schedule;
    run: ScheduleRun;
    routines: ReturnType<typeof routinesRepository>;
    now: Date;
    nowIso: string;
    nextRunAt: string;
    fired: FiredSchedule[];
  }): void {
    const { schedule, run, routines, now, nowIso, nextRunAt, fired } = input;
    const occurrenceAt = run.occurrenceAt;
    const routine = schedule.routineId ? routines.get(schedule.routineId) : undefined;
    try {
      if (!routine || routine.projectId !== schedule.projectId) {
        throw new AgentTaskDispatchError(409, "Scheduled routine no longer exists in this project", "ROUTINE_MISSING");
      }
      if (routine.agentId !== schedule.agentId) {
        throw new AgentTaskDispatchError(409, "Scheduled routine teammate binding changed", "AGENT_BINDING_CHANGED");
      }
      assertRoutineTarget(this.deps.db, routine, { requireAgent: true });
      const result = dispatchRoutineTask(
        { db: this.deps.db, runner: this.deps.runner, env: this.deps.env ?? process.env, now: () => now },
        routine,
        { requireAgent: true, idempotencyKey: `schedule:${schedule.id}:${run.trigger === "manual" ? `manual:${run.id}` : occurrenceAt}` },
      );
      schedulesRepository(this.deps.db).markDispatched(run.id, result.task.id, nowIso);
      fired.push({
        scheduleId: schedule.id,
        taskId: result.task.id,
        nextRunAt,
        runId: run.id,
        routineId: schedule.routineId,
        occurrenceAt,
        coalesced: run.coalesced,
      });
    } catch (error) {
      const code = error instanceof AgentTaskDispatchError ? error.code : "SCHEDULE_DISPATCH_FAILED";
      schedulesRepository(this.deps.db).markBlocked(run.id, code, error, nowIso);
      this.notify({ subject: "Scheduled routine", text: "Morrow could not start a scheduled routine run; review its schedule history." });
    }
  }

  /** Fire all due schedules once. Returns what fired (for logging/tests). */
  tick(): FiredSchedule[] {
    const now = this.now();
    const nowIso = now.toISOString();
    const schedules = schedulesRepository(this.deps.db);
    const tasks = taskRepository(this.deps.db);
    const routines = routinesRepository(this.deps.db);
    const fired: FiredSchedule[] = [];

    // A queued task is normally re-dispatched by startup recovery. A routine
    // run can also be left `interrupted` when the prior process died after
    // beginning it; replay only these durable schedule-linked tasks here.
    // Pending approvals are excluded by the repository and remain waiting
    // until the approval resolver wakes them.
    const recoveryLeaseMs = Math.max(1_000, this.deps.recoveryLeaseMs ?? 5 * 60_000);
    const recoveryLeaseExpiresAt = new Date(now.getTime() + recoveryLeaseMs).toISOString();
    for (const candidate of schedules.listRecoverableRuns(nowIso)) {
      const taskId = candidate.taskId;
      if (!taskId || this.deps.runner.isActive?.(taskId)) continue;
      const run = schedules.claimRecoverableRun({
        id: candidate.id,
        owner: this.recoveryOwner,
        now: nowIso,
        leaseExpiresAt: recoveryLeaseExpiresAt,
      });
      if (!run?.taskId) continue;
      // The active check is repeated after the atomic claim. If a live runner
      // won the race, release our fence rather than delaying its task by the
      // full recovery lease.
      if (this.deps.runner.isActive?.(run.taskId)) {
        schedules.releaseRecoveryClaim(run.id, this.recoveryOwner, nowIso);
        continue;
      }
      try {
        this.deps.runner.run(run.taskId, { recovered: true });
      } catch (error) {
        schedules.markFailed(run.id, "SCHEDULE_REPLAY_FAILED", error, nowIso);
        this.notify({ subject: "Scheduled routine", text: "Morrow could not resume a scheduled routine run; review its schedule history." });
      }
    }

    // A process can stop after the durable claim and before task creation.
    // Reconcile those rows on the next tick using the same idempotency key;
    // concurrent reconcilers converge on one task rather than dropping work.
    for (const run of schedules.listClaimedRuns()) {
      const schedule = schedules.get(run.scheduleId);
      if (!schedule || schedule.taskKind !== "routine") {
        schedules.markBlocked(run.id, "SCHEDULE_MISSING", "The schedule no longer exists.", nowIso);
        continue;
      }
      this.dispatchRoutineRun({ schedule, run, routines, now, nowIso, nextRunAt: schedule.nextRunAt, fired });
    }

    for (const schedule of schedules.due(nowIso)) {
      const occurrenceAt = schedule.nextRunAt;
      const next = nextRun(schedule.cron, now).toISOString();
      const claimed = schedule.taskKind === "routine"
        ? schedules.claimScheduledOccurrence({
          schedule,
          occurrenceAt,
          nextRunAt: next,
          now: nowIso,
          coalesced: occurrenceAt < nowIso,
        })
        : undefined;

      if (schedule.taskKind === "routine") {
        if (!claimed || !claimed.claimed) continue;
        this.dispatchRoutineRun({ schedule, run: claimed.run, routines, now, nowIso, nextRunAt: next, fired });
        continue;
      }

      // Preserve the pre-routine inspect scheduler exactly: it is still a
      // project-scoped deterministic task and has no schedule_runs history.
      const taskId = randomUUID();
      try {
        tasks.createTask({ id: taskId, projectId: schedule.projectId, kind: schedule.taskKind, status: "queued", createdAt: nowIso });
        this.deps.runner.run(taskId);
        schedules.markRan(schedule.id, nowIso, next);
        fired.push({ scheduleId: schedule.id, taskId, nextRunAt: next });
      } catch (error) {
        // The legacy path has no durable run row; leaving next_run_at due makes
        // the next tick retry rather than silently losing the occurrence.
        try { tasks.updateTaskStatus(taskId, { status: "failed", updatedAt: nowIso, completedAt: nowIso }); } catch { /* best effort */ }
        console.error("Scheduled task dispatch failed", error);
      }
    }

    const legacyFired = fired.filter((item) => item.routineId === undefined);
    if (legacyFired.length > 0) {
      this.notify({ subject: "Scheduled run", text: `Morrow ran ${legacyFired.length} scheduled task(s) at ${nowIso}.` });
    }
    return fired;
  }

  start(intervalMs = 30000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error("Scheduler tick failed", error);
      }
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeSettled?.();
  }
}
