/**
 * Isolates the chronological conversation-list indexes added in migration 65.
 * It measures the same populated database twice: first with the prior
 * single-column indexes, then with the current ordered indexes.
 *
 * Run: pnpm --filter @morrow/orchestrator benchmark:query-latency
 */
import { openDatabase } from "../src/database.js";

const db = openDatabase(":memory:");
const now = "2026-08-23T00:00:00.000Z";
db.prepare("INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?,?)")
  .run("p", 1, "bench", "/tmp/bench", now, now);
db.prepare("INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
  .run("t", 1, "p", "agent_chat", "completed", now, now);
db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
  .run("c", "p", "bench", now, now);

const addMessage = db.prepare(`INSERT INTO conversation_messages
  (id,conversation_id,role,content,task_id,streaming_state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`);
const addCall = db.prepare(`INSERT INTO message_tool_calls
  (id,message_id,task_id,tool_name,args_json,result_json,status,created_at)
  VALUES(?,?,?,?,?,?,?,?)`);
db.transaction(() => {
  for (let index = 0; index < 8_000; index++) {
    const timestamp = `2026-08-23T00:${String(index % 60).padStart(2, "0")}:${String(index % 30).padStart(2, "0")}.000Z`;
    addMessage.run(`m${index}`, "c", index % 2 ? "assistant" : "user", `message ${index}`, "t", "completed", timestamp, timestamp);
    addCall.run(`tc${index}`, "m0", "t", "read_file", "{}", "{}", "completed", timestamp);
  }
})();

const queries = {
  messages: db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at,rowid"),
  callsByMessage: db.prepare("SELECT * FROM message_tool_calls WHERE message_id=? ORDER BY created_at,rowid"),
  callsByTask: db.prepare("SELECT * FROM message_tool_calls WHERE task_id=? ORDER BY created_at,rowid"),
};

function indexShape(ordered: boolean): void {
  const suffix = ordered ? ",created_at" : "";
  db.exec(`
    DROP INDEX conversation_messages_conversation_id_idx;
    CREATE INDEX conversation_messages_conversation_id_idx ON conversation_messages(conversation_id${suffix});
    DROP INDEX message_tool_calls_message_id_idx;
    CREATE INDEX message_tool_calls_message_id_idx ON message_tool_calls(message_id${suffix});
    DROP INDEX message_tool_calls_task_id_idx;
    CREATE INDEX message_tool_calls_task_id_idx ON message_tool_calls(task_id${suffix});
  `);
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function time(statement: typeof queries.messages, parameter: string): number {
  statement.all(parameter);
  const samples = Array.from({ length: 15 }, () => {
    const started = performance.now();
    statement.all(parameter);
    return performance.now() - started;
  });
  return median(samples);
}

function measure(): Record<string, number> {
  return {
    messagesMs: time(queries.messages, "c"),
    callsByMessageMs: time(queries.callsByMessage, "m0"),
    callsByTaskMs: time(queries.callsByTask, "t"),
  };
}

indexShape(false);
const before = measure();
indexShape(true);
const after = measure();
const improvementPercent = Object.fromEntries(Object.keys(before).map((key) => [
  key,
  ((before[key]! - after[key]!) / before[key]!) * 100,
]));
console.log(JSON.stringify({ rowsPerList: 8_000, samples: 15, before, after, improvementPercent }, null, 2));
db.close();
