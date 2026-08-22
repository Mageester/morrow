/**
 * Report the query plan for the statements Morrow issues most often, so a full
 * table scan on a hot path shows up as a failing line instead of as latency.
 *
 * Run: pnpm --filter @morrow/orchestrator exec tsx benchmark/explain-hot-queries.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";

const HOT_QUERIES: Array<{ label: string; sql: string; params: unknown[] }> = [
  { label: "task events by task (append cursor)", sql: "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?", params: ["t"] },
  { label: "task events replay", sql: "SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC", params: ["t"] },
  { label: "task events after cursor", sql: "SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC", params: ["t", 0] },
  { label: "messages by conversation", sql: "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC", params: ["c"] },
  { label: "message by id", sql: "SELECT role, conversation_id FROM conversation_messages WHERE id = ?", params: ["m"] },
  { label: "tool calls by message", sql: "SELECT * FROM message_tool_calls WHERE message_id = ? ORDER BY created_at ASC, id ASC", params: ["m"] },
  { label: "tool calls by task", sql: "SELECT * FROM message_tool_calls WHERE task_id = ? ORDER BY created_at ASC, id ASC", params: ["t"] },
  { label: "tasks by project", sql: "SELECT * FROM tasks WHERE project_id = ?", params: ["p"] },
  { label: "agent state transitions by task", sql: "SELECT * FROM agent_state_transitions WHERE task_id=? ORDER BY sequence ASC", params: ["t"] },
  { label: "evidence by task", sql: "SELECT * FROM task_evidence WHERE task_id = ?", params: ["t"] },
  // Runs once per model-authored delegation, before the approval boundary.
  {
    label: "teammate trust lookup",
    sql: "SELECT * FROM teammate_trust_grants WHERE project_id=? AND target_agent_id=? AND revoked_at IS NULL AND (caller_agent_id=? OR caller_agent_id IS NULL) ORDER BY caller_agent_id IS NULL LIMIT 1",
    params: ["p", "t", "c"],
  },
];

const directory = mkdtempSync(join(tmpdir(), "morrow-eqp-"));
const db = openDatabase(join(directory, "plan.db"));
let scans = 0;
try {
  for (const query of HOT_QUERIES) {
    let plan: string;
    try {
      plan = (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...(query.params as never[])) as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
    } catch (error) {
      plan = `unavailable: ${(error as Error).message}`;
    }
    const scan = /SCAN (?!.*USING (?:INDEX|COVERING INDEX))/.test(plan);
    if (scan) scans++;
    console.log(`${scan ? "SCAN " : "ok   "} ${query.label.padEnd(40)} ${plan}`);
  }
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${scans} hot ${scans === 1 ? "query" : "queries"} without an index.`);
process.exitCode = scans > 0 ? 1 : 0;
