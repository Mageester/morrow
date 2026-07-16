import type Database from "better-sqlite3";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { ExecutionLeaseFenceError } from "./repositories/execution-continuity.js";

export interface ExecutionLeaseClaim {
  segmentId: string;
  ownerId: string;
  generation: number;
}

export type TaskExecutor = (deps: {
  db: Database.Database;
  taskId: string;
  abortSignal?: AbortSignal;
  recovery?: { checkpointCursor: number; executionLease: ExecutionLeaseClaim };
}) => Promise<void>;

export class TaskRunner {
  private activeTasks = new Set<string>();
  private activePromises = new Map<string, Promise<void>>();
  private abortControllers = new Map<string, AbortController>();
  private settledListeners = new Set<(taskId: string) => void>();
  private executor: TaskExecutor;

  constructor(private db: Database.Database, executor?: TaskExecutor) {
    this.executor = executor || (async (deps) => {
      const task = taskRepository(db).getTaskById(deps.taskId);
      if (!task) throw new Error(`Task not found: ${deps.taskId}`);

      if (task.kind === "inspect_workspace") {
        const { executeInspectWorkspaceTask } = await import("./execution/inspect-workspace.js");
        await executeInspectWorkspaceTask({ db, taskId: deps.taskId });
      } else if (task.kind === "agent_chat") {
        const { executeAgentChatTask } = await import("./execution/agent.js");
        await executeAgentChatTask({ db, taskId: deps.taskId, ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}), ...(deps.recovery ? { recovery: deps.recovery } : {}) });
      } else {
        throw new Error(`Unsupported task kind: ${task.kind}`);
      }
    });
  }

  /** True while a task is executing (or queued to execute) in this process. */
  isActive(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  onSettled(listener: (taskId: string) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  run(taskId: string, opts: { recovered?: boolean; resumeCheckpoint?: boolean; checkpointCursor?: number; executionLease?: ExecutionLeaseClaim } = {}) {
    if (this.activeTasks.has(taskId)) {
      throw new Error("Duplicate execution rejected");
    }

    this.activeTasks.add(taskId);

    const records = taskRecordsRepository(this.db);
    // Fresh/queued dispatches record their lifecycle boundary. A durable
    // checkpoint reclaim already has an authoritative cursor, so appending a
    // recovery event here would move that cursor and replay lifecycle history.
    if (!opts.resumeCheckpoint) {
      records.appendEvent({
        id: crypto.randomUUID(),
        taskId,
        type: opts.recovered ? "task.recovery_requeued" : "task.created",
        payload: opts.recovered ? { reason: "restart" } : {},
        createdAt: new Date().toISOString()
      });
    }

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    const promise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        try {
          await this.executor({
            db: this.db,
            taskId,
            abortSignal: controller.signal,
            ...(opts.resumeCheckpoint && opts.checkpointCursor !== undefined && opts.executionLease
              ? { recovery: { checkpointCursor: opts.checkpointCursor, executionLease: opts.executionLease } }
              : {}),
          });
        } catch (e: any) {
          if (controller.signal.aborted || e.message === "AbortError" || e.message === "Task execution cancelled") {
            // Already handled by cancellation path or abort catcher
            return;
          }
          if (e instanceof ExecutionLeaseFenceError || e?.code === "EXECUTION_LEASE_LOST") {
            // A stale executor has no authority to fail or otherwise mutate the
            // task after ownership changed. The fenced winner remains active.
            return;
          }
          console.error("Task execution failed", e);
          try {
            const task = taskRepository(this.db).getTaskById(taskId);
            const timestamp = new Date().toISOString();
            const records = taskRecordsRepository(this.db);
            if (task?.kind === "agent_chat") {
              if (!records.getAgentState(taskId)) records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "idle", details: {}, createdAt: timestamp });
              records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "failed", details: { message: e.message || "Task execution failed" }, createdAt: timestamp });
            }
            if (task?.status === "queued" || task?.status === "running") {
              records.transitionTask(taskId, "failed", {
                id: crypto.randomUUID(),
                createdAt: timestamp,
                payload: { message: e.message || "Task execution failed" },
              });
            }
              
            if (task && task.kind === "agent_chat") {
              const msgRows = this.db.prepare("SELECT id FROM conversation_messages WHERE task_id = ?").all(taskId);
              if (msgRows.length > 0) {
                conversationsRepository(this.db).updateMessageContentAndState(
                  (msgRows[0] as any).id,
                  e.message ? `[Error: ${e.message}]` : "Task execution failed",
                  "failed",
                  new Date().toISOString()
                );
              }
            }
          } catch (persistenceError) {
            console.error("Task failure persistence failed", persistenceError);
          }
        } finally {
          this.activeTasks.delete(taskId);
          this.activePromises.delete(taskId);
          this.abortControllers.delete(taskId);
          for (const listener of this.settledListeners) {
            try { listener(taskId); } catch { /* observers never break runner cleanup */ }
          }
          resolve();
        }
      }, 0);
    });
    
    this.activePromises.set(taskId, promise);
  }

  /**
   * Cancel a task and propagate to its entire persisted descendant tree: a
   * running parent must never leave active subagents behind. Targets are
   * collected from `parent_task_id` (persisted, not in-memory) in a deterministic
   * depth-first, parent-before-child order, then each is cancelled idempotently.
   * Cancelling a child never touches its parent or siblings.
   */
  cancel(taskId: string) {
    const targets = this.collectCancelTargets(taskId);
    targets.forEach((id, index) =>
      this.cancelOne(id, index === 0 ? "user_cancelled" : "parent_cancelled")
    );
  }

  // Depth-first pre-order (parent before children) over the persisted task tree.
  // listChildren orders by (created_at, id), so the traversal is deterministic.
  private collectCancelTargets(rootId: string): string[] {
    const tasks = taskRepository(this.db);
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return; // guard against any cyclic parent link
      seen.add(id);
      order.push(id);
      for (const child of tasks.listChildren(id)) visit(child.id);
    };
    visit(rootId);
    return order;
  }

  // Cancel a single task idempotently. The status check is a compare-and-transition
  // guard: a task already in a terminal state is left untouched (no throw, no
  // duplicate terminal event). `cancel()` is synchronous, so the check and the
  // transition cannot be interleaved by another lifecycle write.
  private cancelOne(taskId: string, reason: "user_cancelled" | "parent_cancelled") {
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
    }

    const records = taskRecordsRepository(this.db);
    const task = taskRepository(this.db).getTaskById(taskId);
    if (task && ["queued", "running"].includes(task.status)) {
      const timestamp = new Date().toISOString();
      if (task.kind === "agent_chat") {
        if (!records.getAgentState(taskId)) records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "idle", details: {}, createdAt: timestamp });
        records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "cancelled", details: { reason }, createdAt: timestamp });
      }
      records.transitionTask(taskId, "cancelled", {
        id: crypto.randomUUID(),
        createdAt: timestamp,
        payload: { reason, message: reason === "parent_cancelled" ? "Task cancelled: parent cancelled" : "Task cancelled by user" }
      });

      if (task.kind === "agent_chat") {
        const msgRows = this.db.prepare("SELECT id FROM conversation_messages WHERE task_id = ?").all(taskId);
        if (msgRows.length > 0) {
          // Retrieve current content and update state to cancelled
          const currentMsg = conversationsRepository(this.db).getMessage((msgRows[0] as any).id);
          conversationsRepository(this.db).updateMessageContentAndState(
            (msgRows[0] as any).id,
            currentMsg?.content || "Task cancelled by user",
            "cancelled",
            new Date().toISOString()
          );
        }
      }
    }

    this.activeTasks.delete(taskId);
    this.activePromises.delete(taskId);
    this.abortControllers.delete(taskId);
  }

  // test-only method
  async waitFor(taskId: string) {
    if (this.activePromises.has(taskId)) {
      await this.activePromises.get(taskId);
    }
  }
}
