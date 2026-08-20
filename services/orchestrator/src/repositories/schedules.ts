import type Database from "better-sqlite3";
import {
  ScheduleRunSchema,
  ScheduleSchema,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunStatus,
  type ScheduleTaskKind,
} from "@morrow/contracts";
import { redactSecrets } from "../provider/credentials.js";

type ScheduleRow = Record<string, unknown>;

function mapSchedule(row: ScheduleRow): Schedule {
  const createdAt = String(row.created_at);
  return ScheduleSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    cron: row.cron,
    taskKind: row.task_kind,
    routineId: row.routine_id ?? null,
    agentId: row.agent_id ?? null,
    enabled: Number(row.enabled) !== 0,
    lastRunAt: row.last_run_at ?? null,
    nextRunAt: row.next_run_at,
    createdAt,
    updatedAt: row.updated_at ?? createdAt,
  });
}

function mapRun(row: ScheduleRow): ScheduleRun {
  const errorMessage = row.error_message == null
    ? null
    : redactSecrets(String(row.error_message)).slice(0, 500);
  return ScheduleRunSchema.parse({
    version: 1,
    id: row.id,
    scheduleId: row.schedule_id,
    projectId: row.project_id,
    routineId: row.routine_id ?? null,
    occurrenceAt: row.occurrence_at,
    occurrenceKey: row.occurrence_key,
    trigger: row.trigger,
    status: row.status,
    taskId: row.task_id ?? null,
    errorCode: row.error_code ?? null,
    // History is a browser/API boundary too: sanitize on read in case a
    // future writer or an older database row bypassed markFailed/markBlocked.
    errorMessage,
    coalesced: Number(row.coalesced) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  });
}

function redactedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text).slice(0, 500) || "Scheduled routine could not be started.";
}

/**
 * Durable storage for both the original inspect-workspace cron jobs and
 * teammate-bound routine schedules. The ticker owns time and dispatch; this
 * repository owns the transaction that claims an occurrence exactly once.
 */
export function schedulesRepository(db: Database.Database) {
  const getScheduleRow = (id: string) => db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  const getRunRow = (id: string) => db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRow | undefined;
  const terminalRunStatuses = ["completed", "verified", "failed", "cancelled"] as const;

  const hydrateTaskStatus = (row: ScheduleRow): void => {
    // Keep task-linked rows inspectable/recoverable even if an older build
    // prematurely marked an interrupted task as failed. Rows without a task
    // are genuinely terminal once their durable status says so.
    const rowIsTerminal = terminalRunStatuses.includes(String(row.status) as typeof terminalRunStatuses[number]);
    if (rowIsTerminal) {
      if (row.recovery_owner != null || row.recovery_lease_expires_at != null) {
        db.prepare(
          `UPDATE schedule_runs SET recovery_owner=NULL,recovery_lease_expires_at=NULL,updated_at=?
           WHERE id=? AND status IN ('completed','verified','failed','cancelled')`,
        ).run(new Date().toISOString(), row.id);
      }
      return;
    }
    if (!row.task_id) return;
    const task = db.prepare("SELECT status FROM tasks WHERE id=?").get(row.task_id) as { status?: string } | undefined;
    if (!task) return;
    let status: ScheduleRunStatus | null = null;
    const pendingApproval = db.prepare(
      "SELECT 1 FROM approvals WHERE task_id=? AND status='pending' LIMIT 1",
    ).get(row.task_id);
    if (pendingApproval) status = "waiting_for_approval";
    else if (task.status === "queued") status = "queued";
    else if (task.status === "running") {
      const state = db.prepare(
        "SELECT state FROM agent_state_transitions WHERE task_id=? ORDER BY sequence DESC LIMIT 1",
      ).get(row.task_id) as { state?: string } | undefined;
      status = state?.state === "waiting_for_approval" ? "waiting_for_approval" : "running";
    } else if (task.status === "verified") status = "verified";
    else if (task.status === "completed") status = "completed";
    else if (task.status === "cancelled") status = "cancelled";
    // A restart-interrupted task is eligible for scheduler replay. Keep its
    // durable run non-terminal until the ticker has requeued it. A pending
    // approval above takes precedence and remains visibly waiting.
    else if (task.status === "interrupted") status = "running";
    else if (task.status === "failed") status = "failed";
    if (!status || status === row.status) return;
    const now = new Date().toISOString();
    const terminal = terminalRunStatuses.includes(status as typeof terminalRunStatuses[number]);
    db.prepare(
      `UPDATE schedule_runs SET status=?,
         recovery_owner=CASE WHEN ? THEN NULL ELSE recovery_owner END,
         recovery_lease_expires_at=CASE WHEN ? THEN NULL ELSE recovery_lease_expires_at END,
         updated_at=?, completed_at=CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END
       WHERE id=? AND status NOT IN ('completed','verified','failed','cancelled')`,
    ).run(status, terminal ? 1 : 0, terminal ? 1 : 0, now, terminal ? 1 : 0, now, row.id);
  };

  const getRun = (id: string): ScheduleRun | undefined => {
    const row = getRunRow(id);
    if (!row) return undefined;
    hydrateTaskStatus(row);
    const refreshed = getRunRow(id);
    return refreshed ? mapRun(refreshed) : undefined;
  };

  return {
    create(input: {
      id: string;
      projectId: string;
      cron: string;
      taskKind: ScheduleTaskKind;
      routineId?: string | null;
      agentId?: string | null;
      enabled?: boolean;
      nextRunAt: string;
      createdAt: string;
      updatedAt?: string;
    }): Schedule {
      const updatedAt = input.updatedAt ?? input.createdAt;
      db.prepare(
        `INSERT INTO schedules (id, project_id, cron, task_kind, enabled, last_run_at, next_run_at, created_at, routine_id, agent_id, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.cron,
        input.taskKind,
        input.enabled === false ? 0 : 1,
        input.nextRunAt,
        input.createdAt,
        input.routineId ?? null,
        input.agentId ?? null,
        updatedAt,
      );
      return this.get(input.id)!;
    },

    get(id: string): Schedule | undefined {
      const row = getScheduleRow(id);
      return row ? mapSchedule(row) : undefined;
    },

    listByProject(projectId: string): Schedule[] {
      return db.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at ASC, id ASC")
        .all(projectId).map((row) => mapSchedule(row as ScheduleRow));
    },

    /** Enabled schedules whose next run is at or before `nowIso`, soonest first. */
    due(nowIso: string): Schedule[] {
      return db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC")
        .all(nowIso).map((row) => mapSchedule(row as ScheduleRow));
    },

    /** Update the user-controlled schedule definition and reset its next tick. */
    update(input: {
      id: string;
      projectId: string;
      cron: string;
      taskKind: ScheduleTaskKind;
      routineId?: string | null;
      agentId?: string | null;
      enabled?: boolean;
      nextRunAt: string;
      updatedAt: string;
    }): Schedule | undefined {
      db.prepare(
        `UPDATE schedules SET cron=?, task_kind=?, routine_id=?, agent_id=?, enabled=?, next_run_at=?, updated_at=?
         WHERE id=? AND project_id=?`,
      ).run(
        input.cron,
        input.taskKind,
        input.routineId ?? null,
        input.agentId ?? null,
        input.enabled === false ? 0 : 1,
        input.nextRunAt,
        input.updatedAt,
        input.id,
        input.projectId,
      );
      return this.get(input.id);
    },

    markRan(id: string, ranAtIso: string, nextRunAtIso: string): Schedule | undefined {
      db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at=? WHERE id = ?")
        .run(ranAtIso, nextRunAtIso, ranAtIso, id);
      return this.get(id);
    },

    setEnabled(id: string, enabled: boolean, updatedAt = new Date().toISOString()): Schedule | undefined {
      db.prepare("UPDATE schedules SET enabled = ?, updated_at=? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    delete(id: string): boolean {
      // schedule_runs intentionally survives this delete as history.
      return db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
    },

    /**
     * Atomically advances a due schedule and claims its exact next occurrence.
     * A second process seeing the stale due row loses the guarded UPDATE and
     * therefore cannot create a second run for the same occurrence.
     */
    claimScheduledOccurrence(input: {
      schedule: Schedule;
      occurrenceAt: string;
      nextRunAt: string;
      now: string;
      coalesced?: boolean;
    }): { run: ScheduleRun; claimed: boolean } | undefined {
      return db.transaction(() => {
        const existing = db.prepare(
          "SELECT * FROM schedule_runs WHERE schedule_id=? AND occurrence_key=?",
        ).get(input.schedule.id, input.occurrenceAt) as ScheduleRow | undefined;
        if (existing) return { run: mapRun(existing), claimed: false };

        const advanced = db.prepare(
          `UPDATE schedules SET last_run_at=?, next_run_at=?, updated_at=?
           WHERE id=? AND enabled=1 AND next_run_at=? AND next_run_at<=?`,
        ).run(input.now, input.nextRunAt, input.now, input.schedule.id, input.occurrenceAt, input.now);
        if (advanced.changes !== 1) return undefined;

        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO schedule_runs(
             id,schedule_id,project_id,routine_id,occurrence_at,occurrence_key,trigger,status,task_id,
             error_code,error_message,coalesced,created_at,updated_at,started_at,completed_at
           ) VALUES(?,?,?,?,?,?, 'scheduled','claimed',NULL,NULL,NULL,?,?,?,NULL,NULL)`,
        ).run(
          id,
          input.schedule.id,
          input.schedule.projectId,
          input.schedule.routineId,
          input.occurrenceAt,
          input.occurrenceAt,
          input.coalesced ? 1 : 0,
          input.now,
          input.now,
        );
        return { run: getRun(id)!, claimed: true };
      })();
    },

    createManualRun(input: { schedule: Schedule; occurrenceAt: string; now: string }): ScheduleRun {
      const id = crypto.randomUUID();
      const occurrenceKey = `manual:${id}`;
      db.prepare(
        `INSERT INTO schedule_runs(
           id,schedule_id,project_id,routine_id,occurrence_at,occurrence_key,trigger,status,task_id,
           error_code,error_message,coalesced,created_at,updated_at,started_at,completed_at
         ) VALUES(?,?,?,?,?,?, 'manual','claimed',NULL,NULL,NULL,0,?,?,NULL,NULL)`,
      ).run(
        id,
        input.schedule.id,
        input.schedule.projectId,
        input.schedule.routineId,
        input.occurrenceAt,
        occurrenceKey,
        input.now,
        input.now,
      );
      return this.getRun(id)!;
    },

    markDispatched(id: string, taskId: string, now = new Date().toISOString()): ScheduleRun | undefined {
      db.transaction(() => {
        const updated = db.prepare(
          "UPDATE schedule_runs SET status='queued',task_id=?,recovery_owner=NULL,recovery_lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed'",
        ).run(taskId, now, id);
        if (updated.changes !== 1) return;
        const run = db.prepare("SELECT routine_id FROM schedule_runs WHERE id=?").get(id) as { routine_id?: string | null } | undefined;
        if (run?.routine_id) {
          db.prepare(
            "UPDATE routines SET run_count=run_count+1,last_run_at=?,updated_at=? WHERE id=?",
          ).run(now, now, run.routine_id);
          db.prepare("UPDATE schedule_runs SET routine_run_recorded=1 WHERE id=?").run(id);
        }
      })();
      return getRun(id);
    },

    markBlocked(id: string, errorCode: string, error: unknown, now = new Date().toISOString()): ScheduleRun | undefined {
      db.prepare(
        `UPDATE schedule_runs SET status='blocked',error_code=?,error_message=?,recovery_owner=NULL,recovery_lease_expires_at=NULL,updated_at=?,completed_at=?
         WHERE id=? AND status IN ('claimed','queued','running','waiting_for_approval')`,
      ).run(errorCode.slice(0, 120), redactedError(error), now, now, id);
      return getRun(id);
    },

    markFailed(id: string, errorCode: string, error: unknown, now = new Date().toISOString()): ScheduleRun | undefined {
      db.prepare(
        `UPDATE schedule_runs SET status='failed',error_code=?,error_message=?,recovery_owner=NULL,recovery_lease_expires_at=NULL,updated_at=?,completed_at=?
         WHERE id=? AND status NOT IN ('completed','verified','failed','cancelled')`,
      ).run(errorCode.slice(0, 120), redactedError(error), now, now, id);
      return getRun(id);
    },

    markTaskSettled(taskId: string, status: string, now = new Date().toISOString()): ScheduleRun | undefined {
      const mapped: ScheduleRunStatus = status === "verified" ? "verified"
        : status === "completed" ? "completed"
          : status === "cancelled" ? "cancelled" : "failed";
      db.prepare(
        `UPDATE schedule_runs SET
           status=CASE WHEN status IN ('completed','verified','failed','cancelled') THEN status ELSE ? END,
           recovery_owner=NULL,recovery_lease_expires_at=NULL,
           updated_at=?,
           completed_at=CASE WHEN status IN ('completed','verified','failed','cancelled') THEN completed_at ELSE ? END
         WHERE task_id=?`,
      ).run(mapped, now, now, taskId);
      const row = db.prepare("SELECT id FROM schedule_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId) as { id?: string } | undefined;
      return row?.id ? getRun(row.id) : undefined;
    },

    getRun,

    getRunByTaskId(taskId: string): ScheduleRun | undefined {
      const row = db.prepare("SELECT id FROM schedule_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId) as { id?: string } | undefined;
      return row?.id ? getRun(row.id) : undefined;
    },

    listRuns(scheduleId: string, limit = 100): ScheduleRun[] {
      const rows = db.prepare(
        "SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY occurrence_at DESC, created_at DESC, id DESC LIMIT ?",
      ).all(scheduleId, Math.min(Math.max(limit, 1), 500)) as ScheduleRow[];
      rows.forEach(hydrateTaskStatus);
      return rows.map((row) => {
        const refreshed = getRunRow(String(row.id));
        return mapRun(refreshed ?? row);
      });
    },

    listRunsByProject(projectId: string, limit = 100): ScheduleRun[] {
      const rows = db.prepare(
        "SELECT * FROM schedule_runs WHERE project_id=? ORDER BY occurrence_at DESC, created_at DESC, id DESC LIMIT ?",
      ).all(projectId, Math.min(Math.max(limit, 1), 500)) as ScheduleRow[];
      rows.forEach(hydrateTaskStatus);
      return rows.map((row) => {
        const refreshed = getRunRow(String(row.id));
        return mapRun(refreshed ?? row);
      });
    },

    /** Occurrences claimed before a process crash but not yet bound to a task. */
    listClaimedRuns(limit = 100): ScheduleRun[] {
      const rows = db.prepare(
        "SELECT * FROM schedule_runs WHERE status='claimed' AND task_id IS NULL ORDER BY created_at ASC, id ASC LIMIT ?",
      ).all(Math.min(Math.max(limit, 1), 500)) as ScheduleRow[];
      return rows.map(mapRun);
    },

    /** Routine tasks persisted as queued/interrupted across a process restart. */
    listRecoverableRuns(nowOrLimit: string | number = new Date().toISOString(), limit = 100): ScheduleRun[] {
      // Keep the original `listRecoverableRuns(limit)` shape for callers that
      // only need a bounded read, while the ticker supplies its clock so lease
      // expiry is deterministic and testable.
      const now = typeof nowOrLimit === "number" ? new Date().toISOString() : nowOrLimit;
      const effectiveLimit = typeof nowOrLimit === "number" ? nowOrLimit : limit;
      const rows = db.prepare(
        `SELECT sr.* FROM schedule_runs sr
         JOIN tasks t ON t.id=sr.task_id
         WHERE sr.task_id IS NOT NULL
           AND sr.status IN ('queued','running','waiting_for_approval')
           AND t.status IN ('queued','interrupted')
           AND (sr.recovery_lease_expires_at IS NULL OR sr.recovery_lease_expires_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='pending'
           )
         ORDER BY sr.created_at ASC, sr.id ASC LIMIT ?`,
      ).all(now, Math.min(Math.max(effectiveLimit, 1), 500)) as ScheduleRow[];
      rows.forEach(hydrateTaskStatus);
      return rows.map((row) => {
        const refreshed = getRunRow(String(row.id));
        return mapRun(refreshed ?? row);
      });
    },

    /**
     * Atomically fences one restart recovery attempt.  The lease is the
     * durable hand-off between scheduler processes: a second ticker cannot
     * claim the same task until the first runner settles it or the lease
     * expires.  Task and approval predicates are repeated in the UPDATE so a
     * stale candidate list can never bypass current policy.
     */
    claimRecoverableRun(input: {
      id: string;
      owner: string;
      now: string;
      leaseExpiresAt: string;
    }): ScheduleRun | undefined {
      return db.transaction(() => {
        const claimed = db.prepare(
          `UPDATE schedule_runs
           SET recovery_owner=?, recovery_lease_expires_at=?, recovery_attempts=recovery_attempts+1, updated_at=?
           WHERE id=?
             AND task_id IS NOT NULL
             AND status IN ('queued','running','waiting_for_approval')
             AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= ?)
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id=schedule_runs.task_id AND t.status IN ('queued','interrupted')
             )
             AND NOT EXISTS (
               SELECT 1 FROM approvals a
               WHERE a.task_id=schedule_runs.task_id AND a.status='pending'
             )`,
        ).run(
          input.owner,
          input.leaseExpiresAt,
          input.now,
          input.id,
          input.now,
        );
        return claimed.changes === 1 ? getRun(input.id) : undefined;
      })();
    },

    /** Release a claim when a runner became active between candidate read and claim. */
    releaseRecoveryClaim(id: string, owner: string, now = new Date().toISOString()): ScheduleRun | undefined {
      db.prepare(
        `UPDATE schedule_runs SET recovery_owner=NULL,recovery_lease_expires_at=NULL,updated_at=?
         WHERE id=? AND recovery_owner=? AND status NOT IN ('completed','verified','failed','cancelled')`,
      ).run(now, id, owner);
      return getRun(id);
    },
  };
}

export type SchedulesRepository = ReturnType<typeof schedulesRepository>;
