import type Database from "better-sqlite3";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";

export type TaskExecutor = (deps: { db: Database.Database; taskId: string; abortSignal?: AbortSignal }) => Promise<void>;

export class TaskRunner {
  private activeTasks = new Set<string>();
  private activePromises = new Map<string, Promise<void>>();
  private abortControllers = new Map<string, AbortController>();
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
        await executeAgentChatTask({ db, taskId: deps.taskId, ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}) });
      } else {
        throw new Error(`Unsupported task kind: ${task.kind}`);
      }
    });
  }

  run(taskId: string) {
    if (this.activeTasks.has(taskId)) {
      throw new Error("Duplicate execution rejected");
    }

    this.activeTasks.add(taskId);
    
    const records = taskRecordsRepository(this.db);
    records.appendEvent({
      id: crypto.randomUUID(),
      taskId,
      type: "task.created",
      payload: {},
      createdAt: new Date().toISOString()
    });

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    const promise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        try {
          await this.executor({ db: this.db, taskId, abortSignal: controller.signal });
        } catch (e: any) {
          if (controller.signal.aborted || e.message === "AbortError" || e.message === "Task execution cancelled") {
            // Already handled by cancellation path or abort catcher
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
          resolve();
        }
      }, 0);
    });
    
    this.activePromises.set(taskId, promise);
  }

  cancel(taskId: string) {
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
    }
    
    // Perform state transition immediately if it was running or queued
    const records = taskRecordsRepository(this.db);
    const task = taskRepository(this.db).getTaskById(taskId);
    if (task && ["queued", "running"].includes(task.status)) {
      const timestamp = new Date().toISOString();
      if (task.kind === "agent_chat") {
        if (!records.getAgentState(taskId)) records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "idle", details: {}, createdAt: timestamp });
        records.transitionAgentState(taskId, { id: crypto.randomUUID(), state: "cancelled", details: { reason: "user_cancelled" }, createdAt: timestamp });
      }
      records.transitionTask(taskId, "cancelled", {
        id: crypto.randomUUID(),
        createdAt: timestamp,
        payload: { message: "Task cancelled by user" }
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
