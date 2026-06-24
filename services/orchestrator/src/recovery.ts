import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { taskRecordsRepository } from "./repositories/task-records.js";

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
