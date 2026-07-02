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
  `},
  {id:8,name:"change_sets_and_continuations",sql:`
    CREATE TABLE change_sets (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
      state TEXT NOT NULL,
      diff TEXT NOT NULL,
      diff_hash TEXT NOT NULL,
      original_hashes_json TEXT NOT NULL,
      post_apply_hashes_json TEXT,
      backup_references_json TEXT,
      undo_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX change_sets_project_id_idx ON change_sets(project_id);
    CREATE INDEX change_sets_task_id_idx ON change_sets(task_id);
    CREATE TABLE task_continuations (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `},
  {id:9,name:"onboarding_and_settings",sql:`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `},
  {id:10,name:"full_text_search_index",sql:`
    CREATE VIRTUAL TABLE search_index USING fts5(
      kind UNINDEXED,
      ref_id UNINDEXED,
      project_id UNINDEXED,
      conversation_id UNINDEXED,
      title,
      body,
      created_at UNINDEXED,
      tokenize = 'porter unicode61'
    );

    -- Conversations: title is the searchable body.
    CREATE TRIGGER search_conv_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      VALUES('conversation', new.id, new.project_id, new.id, new.title, new.title, new.created_at);
    END;
    CREATE TRIGGER search_conv_au AFTER UPDATE OF title ON conversations BEGIN
      UPDATE search_index SET title=new.title, body=new.title
      WHERE kind='conversation' AND ref_id=new.id;
    END;
    -- Deleting a conversation clears its own entry plus every message and
    -- conversation-scoped memory entry sharing its id. This is robust whether or
    -- not foreign-key cascades fire child triggers.
    CREATE TRIGGER search_conv_ad AFTER DELETE ON conversations BEGIN
      DELETE FROM search_index WHERE conversation_id=old.id;
    END;

    -- Messages: indexed by their content, project derived from the conversation.
    CREATE TRIGGER search_msg_ai AFTER INSERT ON conversation_messages BEGIN
      INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      VALUES('message', new.id,
        (SELECT project_id FROM conversations WHERE id=new.conversation_id),
        new.conversation_id, new.role, new.content, new.created_at);
    END;
    CREATE TRIGGER search_msg_au AFTER UPDATE OF content ON conversation_messages BEGIN
      UPDATE search_index SET body=new.content WHERE kind='message' AND ref_id=new.id;
    END;
    CREATE TRIGGER search_msg_ad AFTER DELETE ON conversation_messages BEGIN
      DELETE FROM search_index WHERE kind='message' AND ref_id=old.id;
    END;

    -- Tasks: searchable by kind/type and status.
    CREATE TRIGGER search_task_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      VALUES('task', new.id, new.project_id, NULL, new.type, new.type||' '||new.status, new.created_at);
    END;
    CREATE TRIGGER search_task_au AFTER UPDATE OF status ON tasks BEGIN
      UPDATE search_index SET body=new.type||' '||new.status WHERE kind='task' AND ref_id=new.id;
    END;
    CREATE TRIGGER search_task_ad AFTER DELETE ON tasks BEGIN
      DELETE FROM search_index WHERE kind='task' AND ref_id=old.id;
    END;

    -- Memory: searchable by content; scope label kept as the title.
    CREATE TRIGGER search_mem_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      VALUES('memory', new.id, new.project_id, new.conversation_id, new.scope, new.content, new.created_at);
    END;
    CREATE TRIGGER search_mem_au AFTER UPDATE OF content ON memory_entries BEGIN
      UPDATE search_index SET body=new.content WHERE kind='memory' AND ref_id=new.id;
    END;
    CREATE TRIGGER search_mem_ad AFTER DELETE ON memory_entries BEGIN
      DELETE FROM search_index WHERE kind='memory' AND ref_id=old.id;
    END;

    -- Safety net for project deletion: clears any remaining rows for the project.
    CREATE TRIGGER search_project_ad AFTER DELETE ON projects BEGIN
      DELETE FROM search_index WHERE project_id=old.id;
    END;

    -- Backfill existing rows so search works over historical data immediately.
    INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      SELECT 'conversation', id, project_id, id, title, title, created_at FROM conversations;
    INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      SELECT 'message', m.id, c.project_id, m.conversation_id, m.role, m.content, m.created_at
      FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id;
    INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      SELECT 'task', id, project_id, NULL, type, type||' '||status, created_at FROM tasks;
    INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
      SELECT 'memory', id, project_id, conversation_id, scope, content, created_at FROM memory_entries;
  `},
  {id:11,name:"memory_provenance_and_pinning",sql:`
    ALTER TABLE memory_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_entries ADD COLUMN origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
    CREATE INDEX memory_entries_origin_idx ON memory_entries(origin_task_id);
  `},
  {id:12,name:"task_idempotency_keys",sql:`
    ALTER TABLE tasks ADD COLUMN idempotency_key TEXT;
    CREATE UNIQUE INDEX tasks_idempotency_key_idx ON tasks(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `},
  {id:13,name:"skill_usage",sql:`
    CREATE TABLE skill_usage (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      PRIMARY KEY (project_id, skill_id)
    );
  `},
  {id:14,name:"schedules",sql:`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cron TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at);
    CREATE INDEX schedules_project_idx ON schedules(project_id);
  `},
  {id:15,name:"agents_and_permissions",sql:`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      instructions TEXT,
      provider_override TEXT,
      model_override TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX agents_project_id_idx ON agents(project_id);
    CREATE TABLE agent_tool_permissions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      effect TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, tool_name)
    );
    CREATE INDEX agent_tool_permissions_agent_idx ON agent_tool_permissions(agent_id);
    CREATE TABLE agent_skill_access (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, skill_id)
    );
    CREATE INDEX agent_skill_access_agent_idx ON agent_skill_access(agent_id);
  `},
  {id:16,name:"task_parent_links",sql:`
    ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
    CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
  `},
  {id:17,name:"task_agent_links",sql:`
    ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
    CREATE INDEX tasks_agent_idx ON tasks(agent_id);
  `},
  {id:18,name:"audit_log",sql:`
    CREATE TABLE audit_log (
      seq INTEGER PRIMARY KEY,
      project_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `},
  {id:19,name:"checkpoints",sql:`
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      files_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE INDEX checkpoints_project_idx ON checkpoints(project_id);
  `}
];
export function openDatabase(file:string){if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});const db=new Database(file);db.pragma("foreign_keys = ON");db.pragma("busy_timeout = 5000");db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");const applied=new Set((db.prepare("SELECT id FROM schema_migrations").all()as{id:number}[]).map(x=>x.id));for(const m of migrations){if(applied.has(m.id))continue;db.transaction(()=>{db.exec(m.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(m.id,m.name,new Date().toISOString())})()}const newest=(db.prepare("SELECT MAX(id) id FROM schema_migrations").get()as{id:number|null}).id;if(newest!==null&&newest>migrations.at(-1)!.id)throw new Error("Database schema is newer than this application");return db}
