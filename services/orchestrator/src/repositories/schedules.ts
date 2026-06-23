import type Database from "better-sqlite3";
import { ScheduleSchema, type Schedule, type ScheduleTaskKind } from "@morrow/contracts";

/**
 * Persistence for cron schedules. Schedules are project-scoped; `due(now)`
 * returns enabled schedules whose next run is at or before `now`, and
 * `markRan` advances a schedule after it fires. The scheduler ticker owns the
 * decision of *when* — this repository is purely storage.
 */
export function schedulesRepository(db: Database.Database) {
  const map = (row: any): Schedule =>
    ScheduleSchema.parse({
      version: 1,
      id: row.id,
      projectId: row.project_id,
      cron: row.cron,
      taskKind: row.task_kind,
      enabled: Number(row.enabled) !== 0,
      lastRunAt: row.last_run_at ?? null,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
    });

  return {
    create(input: {
      id: string;
      projectId: string;
      cron: string;
      taskKind: ScheduleTaskKind;
      nextRunAt: string;
      createdAt: string;
    }): Schedule {
      db.prepare(
        `INSERT INTO schedules (id, project_id, cron, task_kind, enabled, last_run_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`
      ).run(input.id, input.projectId, input.cron, input.taskKind, input.nextRunAt, input.createdAt);
      return this.get(input.id)!;
    },

    get(id: string): Schedule | undefined {
      const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string): Schedule[] {
      return db.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at ASC, id ASC").all(projectId).map(map);
    },

    /** Enabled schedules whose next run is at or before `nowIso`, soonest first. */
    due(nowIso: string): Schedule[] {
      return db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC").all(nowIso).map(map);
    },

    markRan(id: string, ranAtIso: string, nextRunAtIso: string): Schedule | undefined {
      db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(ranAtIso, nextRunAtIso, id);
      return this.get(id);
    },

    setEnabled(id: string, enabled: boolean): Schedule | undefined {
      db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      return this.get(id);
    },

    delete(id: string): boolean {
      return db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
    },
  };
}
