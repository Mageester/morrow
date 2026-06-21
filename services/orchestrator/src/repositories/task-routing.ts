import type Database from "better-sqlite3";
import { RoutingDecisionSchema, type RoutingDecision } from "@morrow/contracts";

export interface TaskRoutingRecord {
  taskId: string;
  presetId: string;
  providerId: string;
  model: string;
  useMemory: boolean;
  decision: RoutingDecision;
  createdAt: string;
}

export function taskRoutingRepository(db: Database.Database) {
  const map = (row: any): TaskRoutingRecord => ({
    taskId: row.task_id,
    presetId: row.preset_id,
    providerId: row.provider_id,
    model: row.model,
    useMemory: Number(row.use_memory) !== 0,
    decision: RoutingDecisionSchema.parse(JSON.parse(row.decision_json)),
    createdAt: row.created_at,
  });

  return {
    upsert(input: { taskId: string; presetId: string; providerId: string; model: string; useMemory: boolean; decision: RoutingDecision; createdAt: string }) {
      const decisionJson = JSON.stringify(RoutingDecisionSchema.parse(input.decision));
      db.prepare(
        `INSERT INTO task_routing (task_id, preset_id, provider_id, model, use_memory, decision_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           preset_id=excluded.preset_id, provider_id=excluded.provider_id, model=excluded.model,
           use_memory=excluded.use_memory, decision_json=excluded.decision_json`
      ).run(input.taskId, input.presetId, input.providerId, input.model, input.useMemory ? 1 : 0, decisionJson, input.createdAt);
      return this.get(input.taskId)!;
    },
    get(taskId: string): TaskRoutingRecord | undefined {
      const row = db.prepare("SELECT * FROM task_routing WHERE task_id = ?").get(taskId);
      return row ? map(row) : undefined;
    },
  };
}
