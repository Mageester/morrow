import type Database from "better-sqlite3";
import { executeInspectWorkspaceTask } from "./execution/inspect-workspace.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";

export class TaskRunner {
  private activeTasks = new Set<string>();
  private activePromises = new Map<string, Promise<void>>();

  constructor(private db: Database.Database) {}

  run(taskId: string) {
    if (this.activeTasks.has(taskId)) {
      throw new Error("Duplicate execution rejected");
    }

    this.activeTasks.add(taskId);
    const promise = (async () => {
      try {
        executeInspectWorkspaceTask({ db: this.db, taskId });
      } catch (e) {
        // executeInspectWorkspaceTask handles persistence of failure
        console.error("Task execution failed", e);
      } finally {
        this.activeTasks.delete(taskId);
        this.activePromises.delete(taskId);
      }
    })();
    this.activePromises.set(taskId, promise);
  }

  // test-only method
  async waitFor(taskId: string) {
    if (this.activePromises.has(taskId)) {
      await this.activePromises.get(taskId);
    }
  }
}
