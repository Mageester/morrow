import type Database from "better-sqlite3";

export interface TaskContinuation {
  taskId: string;
  toolCallId: string;
  toolName: string;
  args: any;
  createdAt: string;
}

export function taskContinuationsRepository(db: Database.Database) {
  return {
    save(input: Omit<TaskContinuation, "createdAt">, now = new Date().toISOString()): void {
      db.prepare(
        `INSERT INTO task_continuations (task_id, tool_call_id, tool_name, args_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           tool_call_id = excluded.tool_call_id,
           tool_name = excluded.tool_name,
           args_json = excluded.args_json,
           created_at = excluded.created_at`
      ).run(input.taskId, input.toolCallId, input.toolName, JSON.stringify(input.args), now);
    },

    get(taskId: string): TaskContinuation | undefined {
      const row = db.prepare("SELECT * FROM task_continuations WHERE task_id = ?").get(taskId) as any;
      if (!row) return undefined;
      return {
        taskId: row.task_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        args: JSON.parse(row.args_json),
        createdAt: row.created_at,
      };
    },

    delete(taskId: string): boolean {
      return db.prepare("DELETE FROM task_continuations WHERE task_id = ?").run(taskId).changes > 0;
    },
  };
}
