import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { taskRecordsRepository } from "./repositories/task-records.js";

export function recoverRunningTasks(db: Database.Database, records = taskRecordsRepository(db), timestamp = new Date().toISOString()): number {
  const taskIds = (db.prepare("SELECT id FROM tasks WHERE status='running' ORDER BY id ASC").all() as { id: string }[]).map((row) => row.id);
  for (const taskId of taskIds) db.transaction(() => {
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: timestamp, payload: {} });
    records.appendEvent({ id: randomUUID(), taskId, type: "task.recovery_required", payload: {}, createdAt: timestamp });
  })();
  
  // Transition streaming/queued messages to interrupted
  db.transaction(() => {
    db.prepare("UPDATE conversation_messages SET streaming_state='interrupted', updated_at=? WHERE streaming_state IN ('streaming', 'queued')").run(timestamp);
  })();
  
  return taskIds.length;
}
