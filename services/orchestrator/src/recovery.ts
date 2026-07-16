import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { taskRepository } from "./repositories/tasks.js";
import {
  createExecutionLeaseOwnerId,
  executionLeaseOwnerStatus,
  executionContinuityRepository,
} from "./repositories/execution-continuity.js";
import type { MissionControllerRunner } from "./mission/controller-runner.js";

/**
 * Minimal structural view of the task runner that reconciliation needs. Kept
 * structural (not a `TaskRunner` import) so recovery has no dependency cycle and
 * is trivial to fake in tests.
 */
export interface ReconcilableRunner {
  run(taskId: string, opts?: { recovered?: boolean; resumeCheckpoint?: boolean; checkpointCursor?: number; executionLease?: { segmentId: string; ownerId: string; generation: number } }): void;
  isActive(taskId: string): boolean;
}

export interface ReconcileSummary {
  /** Unknown/legacy `running` tasks marked `interrupted`. */
  interrupted: number;
  /** `queued` tasks re-dispatched to the runner (side-effect-free, safe). */
  requeued: number;
  /** `queued` orphans cancelled because their parent is no longer active. */
  cancelledOrphans: number;
}

export interface MissionReconcileSummary extends ReconcileSummary {
  /** Non-terminal durable mission controllers scheduled for recovery. */
  missionsResumed: number;
}

const TERMINAL_STATUSES = new Set(["completed", "verified", "failed", "cancelled"]);

/**
 * Mark non-preserved `running` tasks as `interrupted` exactly once. The startup
 * reconciler excludes lease-claimed checkpointed agent work; direct callers and
 * legacy/unknown work retain the conservative manual-recovery behavior.
 *
 * Idempotent: a second call finds no `running` rows and is a no-op. Returns the
 * number of tasks interrupted.
 */
export function recoverRunningTasks(
  db: Database.Database,
  records = taskRecordsRepository(db),
  timestamp = new Date().toISOString(),
  options: { preserveTaskIds?: ReadonlySet<string> } = {},
): number {
  const continuity = executionContinuityRepository(db);
  const rows = (db.prepare("SELECT id, type FROM tasks WHERE status='running' ORDER BY id ASC").all() as { id: string; type: string }[])
    .filter((row) => !options.preserveTaskIds?.has(row.id));
  const taskIds: string[] = [];
  for (const row of rows) db.transaction(() => {
    const taskId = row.id;
    if (row.type === "agent_chat") {
      const runningSegment = continuity.getRunningSegment(taskId);
      if (runningSegment) {
        if (!runningSegment.ownerId || executionLeaseOwnerStatus(runningSegment.ownerId) !== "dead") return;
        if (!continuity.failAbandonedSegment({
          segmentId: runningSegment.id,
          expectedOwnerId: runningSegment.ownerId,
          expectedGeneration: runningSegment.generation,
          reason: "restart_interrupted",
          now: timestamp,
        })) return;
      }
    }
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: timestamp, payload: {} });
    if (row.type === "agent_chat") {
      if (!records.getAgentState(taskId)) records.transitionAgentState(taskId, { id: randomUUID(), state: "idle", details: {}, createdAt: timestamp });
      records.transitionAgentState(taskId, { id: randomUUID(), state: "interrupted", details: { reason: "restart" }, createdAt: timestamp });
    }
    records.appendEvent({ id: randomUUID(), taskId, type: "task.recovery_required", payload: {}, createdAt: timestamp });
    taskIds.push(taskId);
  })();

  // Transition streaming/queued messages to interrupted
  if (taskIds.length > 0) {
    db.transaction(() => {
      const placeholders = taskIds.map(() => "?").join(", ");
      db.prepare(
        `UPDATE conversation_messages
         SET streaming_state='interrupted', updated_at=?
         WHERE task_id IN (${placeholders}) AND streaming_state IN ('streaming', 'queued')`
      ).run(timestamp, ...taskIds);
    })();
  }

  return taskIds.length;
}

/**
 * Deterministic startup reconciliation. Run once, after the runner is
 * constructed and before serving traffic. It makes persisted task state truthful
 * and consistent, then re-dispatches the work that is safe to resume:
 *
 *  1. Claim checkpointed agent segments with a durable lease and resume them
 *     without changing task/message state or appending a task lifecycle event.
 *  2. Unknown `running` work -> `interrupted` via {@link recoverRunningTasks}.
 *  3. `queued` tasks are re-dispatched to the runner. A task only leaves `queued`
 *     once its executor has begun (the executor's first persisted action is the
 *     `queued -> running` transition), so a task still in `queued` has done **no**
 *     work and re-running it cannot duplicate execution.
 *  4. Parent/child consistency: a `queued` child whose parent is already in a
 *     terminal state (or missing) can never be synthesized by that parent, so it
 *     is cancelled (`queued -> cancelled`, reason `parent_terminal`/`parent_missing`)
 *     instead of being run as orphaned work. A `queued` child whose parent is
 *     itself being recovered (queued/running/interrupted) is re-dispatched.
 *
 * Idempotent: tasks already active in the runner are skipped, and step 1 is a
 * no-op on a second call. Deterministic: rows are processed in stable
 * `created_at, id` order with no timing dependence.
 */
export function reconcileTasksOnStartup(
  { db, runner, records = taskRecordsRepository(db), now = () => new Date().toISOString() }:
    { db: Database.Database; runner: ReconcilableRunner; records?: ReturnType<typeof taskRecordsRepository>; now?: () => string }
): ReconcileSummary {
  const reconciliationAt = now();
  const continuity = executionContinuityRepository(db);
  const resumable = db.prepare(`
    SELECT DISTINCT t.id
    FROM tasks t
    JOIN agent_execution_segments s ON s.task_id=t.id AND s.status='running'
    JOIN agent_execution_checkpoints c ON c.task_id=t.id
    WHERE t.status='running' AND t.type='agent_chat'
      AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='pending')
    ORDER BY t.created_at ASC,t.id ASC
  `).all() as { id: string }[];
  const preservedResumable = new Set(resumable.map((row) => row.id));
  const claimed: Array<{ taskId: string; checkpointCursor: number; executionLease: { segmentId: string; ownerId: string; generation: number } }> = [];
  const leaseExpiresAt = new Date(Date.parse(reconciliationAt) + 5 * 60_000).toISOString();
  for (const row of resumable) {
    if (runner.isActive(row.id)) continue;
    const running = continuity.getRunningSegment(row.id);
    if (!running) continue;
    if (executionLeaseOwnerStatus(running.ownerId) !== "dead") continue;
    const ownerId = createExecutionLeaseOwnerId();
    const claim = continuity.claimResumableSegment({
      taskId: row.id,
      ownerId,
      expectedOwnerId: running.ownerId,
      expectedGeneration: running.generation,
      takeoverReason: "owner_dead",
      now: reconciliationAt,
      leaseExpiresAt,
    });
    if (claim) claimed.push({
      taskId: row.id,
      checkpointCursor: claim.checkpointCursor,
      executionLease: { segmentId: claim.segment.id, ownerId, generation: claim.segment.generation },
    });
  }

  // Legacy/unknown running work still follows the conservative interruption
  // path. Claimed or actively leased checkpointed work remains non-terminal.
  const interrupted = recoverRunningTasks(db, records, reconciliationAt, { preserveTaskIds: preservedResumable });

  const tasks = taskRepository(db);
  const queued = db
    .prepare("SELECT id, parent_task_id AS parentTaskId FROM tasks WHERE status='queued' ORDER BY created_at ASC, id ASC")
    .all() as { id: string; parentTaskId: string | null }[];

  let requeued = 0;
  let cancelledOrphans = 0;

  for (const row of claimed) {
    runner.run(row.taskId, { recovered: true, resumeCheckpoint: true, checkpointCursor: row.checkpointCursor, executionLease: row.executionLease });
    requeued++;
  }

  for (const row of queued) {
    if (runner.isActive(row.id)) continue; // idempotency / belt-and-suspenders

    if (row.parentTaskId) {
      const parent = tasks.getTaskById(row.parentTaskId);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) {
        records.transitionTask(row.id, "cancelled", {
          id: randomUUID(),
          createdAt: now(),
          payload: {
            reason: parent ? "parent_terminal" : "parent_missing",
            message: "Subagent cancelled during restart reconciliation: parent is no longer active",
          },
        });
        cancelledOrphans++;
        continue;
      }
    }

    // A `queued` task may carry partial pre-`running` artifacts left by a start
    // that crashed (hard kill) after advancing its agent-state/plan but before
    // persisting the `queued -> running` transition. Those would make the fresh
    // re-dispatch collide with a stale agent-state chain (e.g. `planning ->
    // understanding` is rejected) and fail the task. Clear them so re-dispatch is
    // a clean attempt; task_events are preserved as the audit trail. These are
    // no-ops for a never-started task (and for deterministic tasks, which carry
    // no agent state).
    db.prepare("DELETE FROM agent_state_transitions WHERE task_id=?").run(row.id);
    db.prepare("DELETE FROM plan_steps WHERE task_id=?").run(row.id);
    db.prepare("DELETE FROM task_continuations WHERE task_id=?").run(row.id);

    runner.run(row.id, { recovered: true });
    requeued++;
  }

  return { interrupted, requeued, cancelledOrphans };
}

/**
 * Unified process-start recovery. Mission controllers are scheduled first so
 * they establish fenced ownership before checkpoint-aware task recovery runs.
 * A final wake observes any task state reconciled in the second phase.
 */
export function reconcileMissionsOnStartup(
  { db, runner, controllerRunner, records, now = () => new Date().toISOString() }:
    {
      db: Database.Database;
      runner: ReconcilableRunner;
      controllerRunner: Pick<MissionControllerRunner, "run" | "wake" | "isActive">;
      records?: ReturnType<typeof taskRecordsRepository>;
      now?: () => string;
    },
): MissionReconcileSummary {
  const missions = db.prepare(`SELECT mission_id AS missionId
    FROM mission_runtime
    WHERE state NOT IN ('blocked','completed','cancelled','abandoned','superseded')
    ORDER BY created_at,mission_id`).all() as Array<{ missionId: string }>;

  let missionsResumed = 0;
  for (const row of missions) {
    if (controllerRunner.isActive(row.missionId)) continue;
    controllerRunner.run(row.missionId);
    missionsResumed += 1;
  }

  const taskSummary = reconcileTasksOnStartup({ db, runner, ...(records ? { records } : {}), now });
  for (const row of missions) controllerRunner.wake(row.missionId);
  return { missionsResumed, ...taskSummary };
}
