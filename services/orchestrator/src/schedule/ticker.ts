import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TaskRunner } from "../runner.js";
import { schedulesRepository } from "../repositories/schedules.js";
import { taskRepository } from "../repositories/tasks.js";
import { nextRun } from "./cron.js";

export interface FiredSchedule {
  scheduleId: string;
  taskId: string;
  nextRunAt: string;
}

/**
 * Drives cron schedules. On each tick it finds every due schedule, starts an
 * **isolated** task run for it through the same runner + containment as
 * interactive work (unattended work never gets elevated privileges), then
 * advances the schedule to its next occurrence. The clock is injectable so the
 * whole thing is deterministic in tests.
 */
export class SchedulerTicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: { db: Database.Database; runner: TaskRunner; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Fire all due schedules once. Returns what fired (for logging/tests). */
  tick(): FiredSchedule[] {
    const now = this.now();
    const nowIso = now.toISOString();
    const schedules = schedulesRepository(this.deps.db);
    const tasks = taskRepository(this.deps.db);
    const fired: FiredSchedule[] = [];

    for (const schedule of schedules.due(nowIso)) {
      const taskId = randomUUID();
      tasks.createTask({ id: taskId, projectId: schedule.projectId, kind: schedule.taskKind, status: "queued", createdAt: nowIso });
      this.deps.runner.run(taskId);
      const next = nextRun(schedule.cron, now).toISOString();
      schedules.markRan(schedule.id, nowIso, next);
      fired.push({ scheduleId: schedule.id, taskId, nextRunAt: next });
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
  }
}
