import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export type Migration={id:number;name:string;sql:string};
export const migrations:Migration[]=[
  {id:1,name:"initial_schema",sql:`CREATE TABLE projects(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,name TEXT NOT NULL,workspace_path TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE tasks(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,type TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,completed_at TEXT);CREATE TABLE plan_steps(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,position INTEGER NOT NULL,title TEXT NOT NULL,description TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(task_id,position));CREATE TABLE task_events(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,sequence));CREATE TABLE execution_disclosures(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,schema_version INTEGER NOT NULL,execution_mode TEXT NOT NULL,provider TEXT NOT NULL,network_access TEXT NOT NULL,workspace_scope TEXT NOT NULL,estimated_cost_usd TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE task_evidence(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,type TEXT NOT NULL,path TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE verification_results(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,schema_version INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX tasks_project_id_idx ON tasks(project_id);CREATE INDEX task_events_task_id_sequence_idx ON task_events(task_id,sequence);`},
  {id:2,name:"execution_disclosure_boundaries",sql:"ALTER TABLE execution_disclosures ADD COLUMN filesystem_access TEXT NOT NULL DEFAULT 'read-only';ALTER TABLE execution_disclosures ADD COLUMN shell_execution INTEGER NOT NULL DEFAULT 0;ALTER TABLE execution_disclosures ADD COLUMN model_invocation INTEGER NOT NULL DEFAULT 0;"},
  {id:3,name:"conversations_and_messages",sql:`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      streaming_state TEXT NOT NULL DEFAULT 'completed',
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE message_tool_calls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT,
      status TEXT NOT NULL,
      error_type TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX conversation_messages_conversation_id_idx ON conversation_messages(conversation_id);
    CREATE INDEX message_tool_calls_message_id_idx ON message_tool_calls(message_id);
    CREATE INDEX message_tool_calls_task_id_idx ON message_tool_calls(task_id);
  `},
  {id:4,name:"routing_and_memory",sql:`
    CREATE TABLE task_routing (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      preset_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      use_memory INTEGER NOT NULL DEFAULT 1,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX memory_entries_project_idx ON memory_entries(project_id);
    CREATE INDEX memory_entries_conversation_idx ON memory_entries(conversation_id);
  `},
  {id:5,name:"conversation_archive",sql:`
    ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id);
  `},
  {id:6,name:"agent_state_transitions",sql:`
    CREATE TABLE agent_state_transitions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, sequence)
    );
    CREATE INDEX agent_state_transitions_task_id_sequence_idx ON agent_state_transitions(task_id, sequence);
  `},
  {id:7,name:"approvals_and_command_trusts",sql:`
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      decision TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX approvals_project_id_created_at_idx ON approvals(project_id, created_at DESC);
    CREATE INDEX approvals_task_id_created_at_idx ON approvals(task_id, created_at ASC);
    CREATE TABLE project_command_trusts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, pattern)
    );
  `}
];
export function openDatabase(file:string){if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});const db=new Database(file);db.pragma("foreign_keys = ON");db.pragma("busy_timeout = 5000");db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");const applied=new Set((db.prepare("SELECT id FROM schema_migrations").all()as{id:number}[]).map(x=>x.id));for(const m of migrations){if(applied.has(m.id))continue;db.transaction(()=>{db.exec(m.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(m.id,m.name,new Date().toISOString())})()}const newest=(db.prepare("SELECT MAX(id) id FROM schema_migrations").get()as{id:number|null}).id;if(newest!==null&&newest>migrations.at(-1)!.id)throw new Error("Database schema is newer than this application");return db}
