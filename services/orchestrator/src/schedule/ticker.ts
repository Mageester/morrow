import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Schedule, ScheduleNotificationEvent, ScheduleRun } from "@morrow/contracts";
import type { TaskRunner } from "../runner.js";
import { schedulesRepository } from "../repositories/schedules.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { routinesRepository } from "../repositories/routines.js";
import { nextRun } from "./cron.js";
import type { OutgoingMessage, MessageAdapter } from "../messaging/adapter.js";
import { AgentTaskDispatchError } from "../mission/task-dispatcher.js";
import { assertRoutineTarget, dispatchRoutineTask } from "../routines/dispatch.js";

/**
 * A dispatch error can carry a path, a command line, or a provider response.
 * The event it lands in is durable and readable from the API, so keep it to a
 * bounded single line rather than whatever the thrower happened to include.
 */
function safeScheduleError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const single = raw.replace(/\s+/g, " ").trim();
  return single.length > 1000 ? `${single.slice(0, 997)}...` : (single || "Scheduled task dispatch failed");
}

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

function notificationEventForRun(run: ScheduleRun): ScheduleNotificationEvent | null {
  if (run.status === "waiting_for_approval") return "waiting_for_approval";
  if (run.status === "completed" || run.status === "verified") return "completed";
  if (run.status === "failed") return "failed";
  if (run.status === "blocked") return "blocked";
  return null;
}

function notificationMessage(event: ScheduleNotificationEvent): { subject: string; text: string } {
  if (event === "waiting_for_approval") {
    return { subject: "Scheduled routine", text: "Morrow scheduled routine run is waiting for approval." };
  }
  if (event === "completed") {
    return { subject: "Scheduled routine", text: "Morrow scheduled routine run completed." };
  }
  if (event === "failed") {
    return { subject: "Scheduled routine", text: "Morrow scheduled routine run failed; review its schedule history." };
  }
  return { subject: "Scheduled routine", text: "Morrow scheduled routine run is blocked; review its schedule history." };
}

/**
 * Drives the one Morrow cron scheduler. Legacy inspect-workspace rows keep
 * their original path; routine rows claim a durable occurrence first, then
 * use the same agent dispatcher as an interactive run.
 */
export class SchedulerTicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly recoveryOwner = `scheduler:${randomUUID()}`;
  private readonly notificationOwner = `scheduler-notify:${randomUUID()}`;
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

  private adaptersFor(schedule?: Schedule): MessageAdapter[] {
    const adapters = schedule?.notification.adapterId
      ? this.deps.adapters?.filter((adapter) => adapter.id === schedule.notification.adapterId)
      : this.deps.adapters;
    return adapters ?? [];
  }

  private adapterIdsFor(schedule: Schedule): string[] {
    // Preserve an explicitly selected adapter id in the outbox even when the
    // adapter is temporarily unavailable after a restart or configuration
    // change. The delivery loop can then retry when that existing adapter
    // returns; an empty "all adapters" selection has nothing to enqueue.
    return schedule.notification.adapterId
      ? [schedule.notification.adapterId]
      : (this.deps.adapters ?? []).map((adapter) => adapter.id);
  }

  private notify(message: { subject: string; text: string }, schedule?: Schedule): void {
    const adapters = this.adaptersFor(schedule);
    if (!adapters.length) return;
    for (const adapter of adapters) void adapter.send(message).catch(() => {
      // Legacy notification is an optional side effect and never changes run truth.
    });
  }

  private notifyRun(schedule: Schedule, run: ScheduleRun, event: ScheduleNotificationEvent): void {
    if (!schedule.notification.events.includes(event)) return;
    const adapterIds = this.adapterIdsFor(schedule);
    if (!adapterIds.length) return;
    const schedules = schedulesRepository(this.deps.db);
    const message = notificationMessage(event);
    schedules.enqueueNotification({
      runId: run.id,
      projectId: run.projectId,
      adapterIds,
      event,
      ...message,
      now: this.now().toISOString(),
    });
  }

  private async deliverNotifications(nowIso: string): Promise<void> {
    const schedules = schedulesRepository(this.deps.db);
    const leaseExpiresAt = new Date(new Date(nowIso).getTime() + 5 * 60_000).toISOString();
    for (const pending of schedules.listPendingNotificationDeliveries(nowIso)) {
      const adapter = this.deps.adapters?.find((candidate) => candidate.id === pending.adapterId);
      // Keep an outbox row pending if its adapter is temporarily unavailable.
      if (!adapter) continue;
      const delivery = schedules.claimNotificationDelivery({
        id: pending.id,
        owner: this.notificationOwner,
        now: nowIso,
        leaseExpiresAt,
      });
      if (!delivery) continue;
      const message: OutgoingMessage = { text: delivery.text, subject: delivery.subject };
      try {
        const result = await adapter.send(message);
        if (result.ok) schedules.markNotificationDelivered(delivery.id, this.notificationOwner, nowIso);
        else schedules.markNotificationRetry(delivery.id, this.notificationOwner, result.detail, nowIso);
      } catch (error) {
        schedules.markNotificationRetry(delivery.id, this.notificationOwner, error, nowIso);
      }
    }
  }

  private onTaskSettled(taskId: string): void {
    const schedules = schedulesRepository(this.deps.db);
    const run = schedules.getRunByTaskId(taskId);
    if (!run || run.trigger !== "scheduled" && run.trigger !== "manual") return;
    const task = taskRepository(this.deps.db).getTaskById(taskId);
    if (!task) return;
    if (!(new Set(["completed", "verified", "failed", "cancelled"])).has(task.status)) return;
    const settled = schedules.markTaskSettled(taskId, task.status, this.now().toISOString());
    if (!settled || settled.routineId === null) return;
    const schedule = schedules.get(settled.scheduleId);
    const event = notificationEventForRun(settled);
    if (!schedule || !event) return;
    this.notifyRun(schedule, settled, event);
    // Settlement callbacks can arrive between ticker intervals. Enqueue first
    // (durably) and then attempt delivery without making the task callback
    // wait on an external adapter.
    void this.deliverNotifications(this.now().toISOString()).catch(() => {
      // Notification delivery never changes schedule/task truth.
    });
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
      const blocked = schedulesRepository(this.deps.db).markBlocked(run.id, code, error, nowIso);
      if (blocked) this.notifyRun(schedule, blocked, "blocked");
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
        const failed = schedules.markFailed(run.id, "SCHEDULE_REPLAY_FAILED", error, nowIso);
        if (failed) {
          const schedule = schedules.get(failed.scheduleId);
          if (schedule) this.notifyRun(schedule, failed, "failed");
        }
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
        //
        // Go through the canonical transition so the failure leaves an event
        // behind. A raw status write made the task read as failed with nothing
        // anywhere saying why, which is the same as no answer at all.
        try {
          const created = tasks.getTaskById(taskId);
          if (created && (created.status === "queued" || created.status === "running")) {
            taskRecordsRepository(this.deps.db).transitionTask(taskId, "failed", {
              id: randomUUID(),
              createdAt: nowIso,
              payload: { scheduleId: schedule.id, message: safeScheduleError(error) },
            });
          }
        } catch { /* best effort: the schedule still retries on the next tick */ }
        console.error("Scheduled task dispatch failed", error);
      }
    }

    // Waiting-for-approval and terminal runs are intentionally observed from
    // durable state: a parked runner emits no settlement callback, while a
    // restart may leave the task terminal before its run projection hydrates.
    // The outbox unique key makes this idempotent across ticker restarts.
    for (const run of schedules.listNotifiableRuns()) {
      const schedule = schedules.get(run.scheduleId);
      const event = notificationEventForRun(run);
      if (schedule && schedule.taskKind === "routine" && event) this.notifyRun(schedule, run, event);
      // Mark every observed row, including legacy/removed schedules and
      // unselected events, so a bounded page advances durably. State changes
      // clear this marker and make the next event observable again.
      schedules.markNotificationObserved(run.id, event);
    }

    // Deliver after enqueueing all observations. Failed adapter calls return
    // to `pending` and are retried by the next tick; successful rows remain
    // `sent` and cannot be duplicated.
    void this.deliverNotifications(nowIso).catch(() => {
      // Notification delivery never changes schedule/task truth.
    });

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
