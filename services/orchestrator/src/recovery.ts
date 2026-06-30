import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { taskRepository } from "./repositories/tasks.js";

/**
 * Minimal structural view of the task runner that reconciliation needs. Kept
 * structural (not a `TaskRunner` import) so recovery has no dependency cycle and
 * is trivial to fake in tests.
 */
export interface ReconcilableRunner {
  run(taskId: string, opts?: { recovered?: boolean }): void;
  isActive(taskId: string): boolean;
}

export interface ReconcileSummary {
  /** `running` tasks marked `interrupted` (abrupt death; need user decision). */
  interrupted: number;
  /** `queued` tasks re-dispatched to the runner (side-effect-free, safe). */
  requeued: number;
  /** `queued` orphans cancelled because their parent is no longer active. */
  cancelledOrphans: number;
}

const TERMINAL_STATUSES = new Set(["completed", "verified", "failed", "cancelled"]);

/**
 * Mark every `running` task as `interrupted` exactly once. A task persisted as
 * `running` when the process died may have produced partial side effects, so it
 * is never auto-resumed — it is surfaced as `interrupted` (plus a
 * `task.recovery_required` event) for an explicit user resume/retry decision.
 *
 * Idempotent: a second call finds no `running` rows and is a no-op. Returns the
 * number of tasks interrupted.
 */
export function recoverRunningTasks(db: Database.Database, records = taskRecordsRepository(db), timestamp = new Date().toISOString()): number {
  const rows = db.prepare("SELECT id, type FROM tasks WHERE status='running' ORDER BY id ASC").all() as { id: string; type: string }[];
  const taskIds = rows.map((row) => row.id);
  for (const row of rows) db.transaction(() => {
    const taskId = row.id;
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: timestamp, payload: {} });
    if (row.type === "agent_chat") {
      if (!records.getAgentState(taskId)) records.transitionAgentState(taskId, { id: randomUUID(), state: "idle", details: {}, createdAt: timestamp });
      records.transitionAgentState(taskId, { id: randomUUID(), state: "interrupted", details: { reason: "restart" }, createdAt: timestamp });
    }
    records.appendEvent({ id: randomUUID(), taskId, type: "task.recovery_required", payload: {}, createdAt: timestamp });
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
 *  1. `running` -> `interrupted` (via {@link recoverRunningTasks}). Not resumed.
 *  2. `queued` tasks are re-dispatched to the runner. A task only leaves `queued`
 *     once its executor has begun (the executor's first persisted action is the
 *     `queued -> running` transition), so a task still in `queued` has done **no**
 *     work and re-running it cannot duplicate execution.
 *  3. Parent/child consistency: a `queued` child whose parent is already in a
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
  // Step 1 runs first so a parent that was `running` is now `interrupted`
  // (an "active" state for the child rule below) before children are evaluated.
  const interrupted = recoverRunningTasks(db, records, now());

  const tasks = taskRepository(db);
  const queued = db
    .prepare("SELECT id, parent_task_id AS parentTaskId FROM tasks WHERE status='queued' ORDER BY created_at ASC, id ASC")
    .all() as { id: string; parentTaskId: string | null }[];

  let requeued = 0;
  let cancelledOrphans = 0;
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
