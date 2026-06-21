import type Database from "better-sqlite3";
import { executeInspectWorkspaceTask } from "./execution/inspect-workspace.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";

export type TaskExecutor = (deps: { db: Database.Database; taskId: string }) => Promise<void>;

export class TaskRunner {
  private activeTasks = new Set<string>();
  private activePromises = new Map<string, Promise<void>>();
  private executor: TaskExecutor;

  constructor(private db: Database.Database, executor?: TaskExecutor) {
    this.executor = executor || (async (deps) => {
      // Import lazily to avoid circular dependencies if needed, or directly
      const { executeInspectWorkspaceTask } = await import("./execution/inspect-workspace.js");
      await executeInspectWorkspaceTask(deps);
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

    const promise = new Promise<void>((resolve) => {
      // Execute on next event loop turn
      setTimeout(async () => {
        try {
          await this.executor({ db: this.db, taskId });
        } catch (e) {
          console.error("Task execution failed", e);
          try {
            const task = taskRepository(this.db).getTaskById(taskId);
            if (task?.status === "queued" || task?.status === "running") {
              taskRecordsRepository(this.db).transitionTask(taskId, "failed", {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                payload: { message: "Task execution failed" },
              });
            }
          } catch (persistenceError) {
            console.error("Task failure persistence failed", persistenceError);
          }
        } finally {
          this.activeTasks.delete(taskId);
          this.activePromises.delete(taskId);
          resolve();
        }
      }, 0);
    });
    
    this.activePromises.set(taskId, promise);
  }

  // test-only method
  async waitFor(taskId: string) {
    if (this.activePromises.has(taskId)) {
      await this.activePromises.get(taskId);
    }
  }
}
