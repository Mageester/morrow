import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./provider/credentials.js";
export type Migration={id:number;name:string;sql?:string;up?:(db:Database.Database)=>void};
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
  `},
  {id:20,name:"processes",sql:`
    CREATE TABLE processes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'pipe',
      pid INTEGER,
      status TEXT NOT NULL,
      exit_code INTEGER,
      run_id TEXT NOT NULL,
      detail TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX processes_project_idx ON processes(project_id);
    CREATE INDEX processes_status_idx ON processes(status);
    CREATE INDEX processes_task_idx ON processes(task_id);
  `},
  {id:21,name:"worktrees",sql:`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      UNIQUE(project_id, branch)
    );
    CREATE INDEX worktrees_project_idx ON worktrees(project_id);
    ALTER TABLE tasks ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL;
  `},
  {id:22,name:"integration_attempts",sql:`
    CREATE TABLE integration_attempts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      source_branch TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      target_commit TEXT NOT NULL,
      status TEXT NOT NULL,
      conflicted_files_json TEXT NOT NULL,
      error_detail TEXT,
      applied_commit TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX integration_attempts_project_idx ON integration_attempts(project_id);
    CREATE INDEX integration_attempts_worktree_idx ON integration_attempts(worktree_id);
  `}
  ,{id:23,name:"context_summaries",sql:`
    CREATE TABLE context_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      method TEXT NOT NULL,
      content TEXT NOT NULL,
      source_start_index INTEGER NOT NULL,
      source_end_index INTEGER NOT NULL,
      source_message_count INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, source_hash)
    );
    CREATE INDEX context_summaries_conversation_idx ON context_summaries(conversation_id, created_at DESC);
    CREATE INDEX context_summaries_task_idx ON context_summaries(task_id);
  `}
  ,{id:24,name:"symbol_index",sql:`
    CREATE TABLE symbol_index_files (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      file_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      indexer_version TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      PRIMARY KEY(project_id, file_path)
    );
    CREATE TABLE symbols (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      language TEXT NOT NULL,
      file_fingerprint TEXT NOT NULL,
      name TEXT NOT NULL,
      fq_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      parent_name TEXT,
      exported INTEGER NOT NULL,
      indexed_at TEXT NOT NULL,
      indexer_version TEXT NOT NULL,
      parser_version TEXT NOT NULL
    );
    CREATE INDEX symbols_project_name_idx ON symbols(project_id, name);
    CREATE INDEX symbols_project_fq_name_idx ON symbols(project_id, fq_name);
    CREATE INDEX symbols_project_file_idx ON symbols(project_id, file_path, start_line, start_column);
    CREATE INDEX symbol_index_files_project_idx ON symbol_index_files(project_id, indexed_at DESC);
  `}
  ,{id:25,name:"missions",sql:`
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      task_tree_root_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      budget_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX missions_project_idx ON missions(project_id, created_at DESC);
    CREATE TABLE mission_criteria (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      ordering INTEGER NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      failure_reason TEXT,
      waiver_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX mission_criteria_mission_idx ON mission_criteria(mission_id, ordering);
    CREATE TABLE mission_evidence (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      criterion_ids_json TEXT NOT NULL DEFAULT '[]',
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      command TEXT,
      exit_code INTEGER,
      output_ref TEXT,
      artifact_path TEXT,
      status TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX mission_evidence_mission_idx ON mission_evidence(mission_id, recorded_at);
    CREATE TABLE mission_failures (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT,
      agent_id TEXT,
      operation TEXT NOT NULL,
      normalized_signature TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      recovery_strategy TEXT,
      recovered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_failures_mission_idx ON mission_failures(mission_id, created_at);
    CREATE INDEX mission_failures_signature_idx ON mission_failures(mission_id, normalized_signature);
    CREATE TABLE mission_checkpoints (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      reason TEXT NOT NULL,
      git_ref TEXT,
      checkpoint_name TEXT,
      affected_files_json TEXT NOT NULL DEFAULT '[]',
      rollback_available INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_checkpoints_mission_idx ON mission_checkpoints(mission_id, created_at);
    CREATE TABLE mission_reviews (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL,
      reviewer_provider TEXT,
      reviewer_model TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_reviews_mission_idx ON mission_reviews(mission_id, created_at DESC);
    CREATE TABLE mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(mission_id, sequence)
    );
    CREATE INDEX mission_events_mission_idx ON mission_events(mission_id, sequence);
  `}
  ,{id:26,name:"task_mission_link",sql:`
    ALTER TABLE tasks ADD COLUMN mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL;
    CREATE INDEX tasks_mission_id_idx ON tasks(mission_id) WHERE mission_id IS NOT NULL;
  `}
  ,{id:27,name:"cortex_project_intelligence",sql:`
    CREATE TABLE project_intelligence (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      repository_fingerprint TEXT NOT NULL,
      architecture_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      refreshed_at TEXT NOT NULL
    );
    CREATE TABLE intelligence_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      approval TEXT,
      freshness TEXT NOT NULL DEFAULT 'current',
      scope TEXT NOT NULL DEFAULT '.',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX intelligence_items_project_kind_idx ON intelligence_items(project_id, kind);
    CREATE TABLE architecture_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, label)
    );
    CREATE INDEX architecture_decisions_project_idx ON architecture_decisions(project_id, created_at);
    CREATE TABLE project_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '.',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX project_rules_project_idx ON project_rules(project_id, created_at);
    CREATE TABLE mission_plan_revisions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(mission_id, revision)
    );
    CREATE TABLE mission_impact_analyses (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_impact_analyses_mission_idx ON mission_impact_analyses(mission_id, created_at);
  `}
  ,{id:28,name:"mission_kernel_contract_ledger_cursor",sql:`
    CREATE TABLE mission_contracts (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      source_prompt TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      verification_commands_json TEXT NOT NULL DEFAULT '[]',
      required_git_result TEXT,
      unresolved_ambiguities_json TEXT NOT NULL DEFAULT '[]',
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mission_requirement_nodes (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      ordering INTEGER NOT NULL,
      statement TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'objective',
      source_prompt_excerpt TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      authoritative INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      affected_files_json TEXT NOT NULL DEFAULT '[]',
      verified_file_hashes_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_failure_json TEXT,
      completed_at TEXT,
      invalidation_history_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX mission_requirement_nodes_mission_idx ON mission_requirement_nodes(mission_id, ordering);
    CREATE UNIQUE INDEX mission_requirement_nodes_one_active ON mission_requirement_nodes(mission_id) WHERE status = 'active';
    CREATE TABLE mission_cursors (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      active_node_id TEXT,
      active_objective TEXT,
      allowed_next_actions_json TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT,
      last_completed_action TEXT,
      frozen_node_ids_json TEXT NOT NULL DEFAULT '[]',
      invalidated_node_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_active_mission (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE SET NULL,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `}
  // ── Migration 29 ────────────────────────────────────────────────────────
  // Migration 28 (above) was edited in place AFTER it had already been applied
  // to real databases (both a database created at commit 29d0364, and a later
  // development database at commit f812872 that carried a divergent, silently
  // edited copy of the SAME migration id). Migration ids are immutable once
  // they can have been applied, so migration 28 above is restored to its
  // EXACT original 29d0364 schema, and every schema change that had been
  // smuggled into the edited copy — the mission_requirement_nodes.source_locator
  // column, and a coherent, ownership-enforced project_active_mission table —
  // is instead delivered here, as migration 29.
  //
  // Because three different historical starting points must all converge on
  // the same final schema (a fresh DB running 1–29 in order; a DB created at
  // 29d0364 with the ORIGINAL migration 28; and a dev DB at f812872 that
  // already has the EDITED migration 28, i.e. already has source_locator and
  // the old ownership triggers), static SQL cannot safely express this
  // migration: `ALTER TABLE ... ADD COLUMN` fails if the column already
  // exists, and the project_active_mission rebuild must not assume which
  // shape it is rebuilding FROM. Migration 29 is therefore a deterministic
  // JS `up(db)` function (see the Migration type and openDatabase below) that
  // inspects the live schema with `PRAGMA table_info` before acting.
  ,{id:29,name:"mission_kernel_contract_ledger_cursor_fixup",up(db){
    // 0) Validate EVERY existing non-null project_active_mission pointer
    //    against missions.project_id BEFORE any mutation below. A historical
    //    29d0364/f812872-era database could legally contain a pointer whose
    //    mission_id refers to a mission owned by a DIFFERENT project (or to no
    //    mission at all — e.g. a hard delete performed with foreign_keys off),
    //    since no ownership trigger existed before this migration. Such a row
    //    is ownership-corrupt, not merely stale: silently carrying it forward
    //    (the previous behavior) preserves a false pointer, and silently
    //    dropping or rewriting it would destroy history without operator
    //    awareness. Either way is unacceptable, so this refuses to upgrade at
    //    all. Because this entire function runs inside ONE transaction (see
    //    openDatabase), throwing here rolls back everything migration 29 would
    //    otherwise do — including the source_locator column and the
    //    schema_migrations row for id 29 itself — leaving the database exactly
    //    as it was, ready for the operator to fix the data and retry.
    const corrupt=db.prepare(`
      SELECT pam.project_id AS projectId, pam.mission_id AS missionId
      FROM project_active_mission pam
      LEFT JOIN missions m ON m.id = pam.mission_id
      WHERE pam.mission_id IS NOT NULL
        AND (m.id IS NULL OR m.project_id IS NOT pam.project_id)
    `).all() as {projectId:string;missionId:string}[];
    if(corrupt.length>0){
      const detail=corrupt.map(c=>`(project_id=${c.projectId}, mission_id=${c.missionId})`).join(", ");
      throw new Error(`migration 29: refusing to upgrade — project_active_mission contains ownership-corrupt row(s) that do not point at a mission owned by that project: ${detail}. Correct or remove the offending row(s) and retry.`);
    }

    // 1) mission_requirement_nodes.source_locator — add it only if it is not
    //    already present (the edited-at-f812872 database already has it; the
    //    genuine 29d0364 database does not).
    const nodeCols=(db.prepare("PRAGMA table_info(mission_requirement_nodes)").all() as {name:string}[]).map(c=>c.name);
    if(!nodeCols.includes("source_locator")){
      db.exec("ALTER TABLE mission_requirement_nodes ADD COLUMN source_locator TEXT");
    }

    // 2) project_active_mission — rebuild into its coherent final shape
    //    regardless of which historical shape it currently has:
    //      • project_id references projects, ON DELETE CASCADE (unchanged);
    //      • mission_id is NOT NULL and references missions ON DELETE CASCADE
    //        (never SET NULL — a NOT NULL column paired with SET NULL is
    //        self-contradictory and would abort the delete instead of
    //        cleanly removing the pointer);
    //      • deleting an active mission therefore removes its pointer row
    //        entirely, via the FK cascade — a caller can never hydrate
    //        `{ missionId: null }`, which the public contract forbids;
    //      • insert/update ownership triggers reject a pointer to a
    //        nonexistent or cross-project mission.
    //    Any existing row whose mission_id is NULL (only possible under the
    //    edited-f812872 nullable shape) is dropped rather than carried
    //    forward, since a null-pointing row is exactly the invalid state
    //    this migration exists to make unrepresentable.
    db.exec("DROP TRIGGER IF EXISTS project_active_mission_owner_ai");
    db.exec("DROP TRIGGER IF EXISTS project_active_mission_owner_au");
    db.exec(`CREATE TABLE project_active_mission_new (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO project_active_mission_new (project_id, mission_id, schema_version, updated_at)
      SELECT project_id, mission_id, schema_version, updated_at
      FROM project_active_mission
      WHERE mission_id IS NOT NULL`);
    db.exec("DROP TABLE project_active_mission");
    db.exec("ALTER TABLE project_active_mission_new RENAME TO project_active_mission");
    // mission_id is NOT NULL here, so an attempted NULL is rejected by the
    // column constraint itself; 'IS NOT' also correctly aborts when the
    // ownership subquery yields NULL (a nonexistent mission id).
    db.exec(`CREATE TRIGGER project_active_mission_owner_ai
    BEFORE INSERT ON project_active_mission
    WHEN (SELECT project_id FROM missions WHERE id = NEW.mission_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'project_active_mission: mission is not owned by this project');
    END`);
    db.exec(`CREATE TRIGGER project_active_mission_owner_au
    BEFORE UPDATE ON project_active_mission
    WHEN (SELECT project_id FROM missions WHERE id = NEW.mission_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'project_active_mission: mission is not owned by this project');
    END`);
  }}
  // ── Migration 30 ────────────────────────────────────────────────────────
  // Durable review-cycle ownership. Before this migration, "which review is
  // authoritative" was decided by reading mission_reviews ORDER BY created_at
  // DESC — a caller-controlled timestamp — and a second review cycle could be
  // started (and its provider call awaited) while an EARLIER cycle's already-
  // persisted verdict was still readable as `mission.finalReview`, letting
  // finalize() grade and close the mission on a stale verdict while the newer
  // cycle was still in flight. mission_review_cycles gives every review cycle
  // a durable identity: at most one row per mission may be 'reserved' at a
  // time (enforced by the partial unique index below, not merely in-memory
  // state), a review can only ever be applied against the exact cycle that
  // reserved it, and missions.current_review_cycle_id is the single
  // authoritative pointer to the review that actually governs grading/
  // hydration — never "whichever row has the latest created_at".
  ,{id:30,name:"mission_review_cycles",sql:`
    CREATE TABLE mission_review_cycles (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','applied')),
      reserved_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(mission_id, sequence)
    );
    CREATE INDEX mission_review_cycles_mission_idx ON mission_review_cycles(mission_id, sequence);
    -- At most one in-flight (reserved) review cycle per mission, enforced
    -- durably at the database level — not by an in-memory lock or promise.
    CREATE UNIQUE INDEX mission_review_cycles_one_reserved ON mission_review_cycles(mission_id) WHERE status = 'reserved';

    ALTER TABLE mission_reviews ADD COLUMN review_cycle_id TEXT REFERENCES mission_review_cycles(id) ON DELETE SET NULL;
    -- The single authoritative "current review" pointer. Set only when a
    -- review cycle is actually APPLIED (never while merely reserved), so a
    -- finalize/hydration read always resolves to the exact cycle that most
    -- recently completed application — sequence-ordered, never timestamp-ordered.
    ALTER TABLE missions ADD COLUMN current_review_cycle_id TEXT REFERENCES mission_review_cycles(id) ON DELETE SET NULL;
  `}
  // ── Migration 31 ────────────────────────────────────────────────────────
  // Adds recoverable leases to review-cycle reservations and repairs the
  // migration-30 authority gap for reviews that existed before cycles did.
  // The whole migration, including validation and schema_migrations insert,
  // is run by openDatabase() in one transaction.
  ,{id:31,name:"mission_review_cycle_leases_and_legacy_hydration",up(db){
    const legacyMissions=db.prepare(`
      SELECT DISTINCT mission_id AS missionId
      FROM mission_reviews
      WHERE review_cycle_id IS NULL
      ORDER BY mission_id
    `).all() as {missionId:string}[];

    const legacyByMission=new Map<string,{id:string;verdict:string;createdAt:string}[]>();
    for(const {missionId} of legacyMissions){
      const reviews=db.prepare(`
        SELECT id, verdict, created_at AS createdAt
        FROM mission_reviews
        WHERE mission_id = ? AND review_cycle_id IS NULL
        ORDER BY created_at ASC, id ASC
      `).all(missionId) as {id:string;verdict:string;createdAt:string}[];
      const latestAt=reviews.at(-1)!.createdAt;
      if(reviews.filter(r=>r.createdAt===latestAt).length>1){
        throw new Error(`migration 31: tied latest legacy review timestamps for mission ${missionId}; refusing to guess review authority`);
      }
      const mission=db.prepare("SELECT status, result_json AS resultJson FROM missions WHERE id = ?").get(missionId) as {status:string;resultJson:string|null};
      if(mission.resultJson){
        let result:{reviewVerdict?:unknown};
        try{result=JSON.parse(mission.resultJson) as {reviewVerdict?:unknown};}
        catch{throw new Error(`migration 31: invalid result JSON for mission ${missionId}`);}
        const latest=reviews.at(-1)!;
        if(result.reviewVerdict!==latest.verdict){
          throw new Error(`migration 31: mission ${missionId} result contradicts latest legacy review verdict (${String(result.reviewVerdict)} != ${latest.verdict})`);
        }
      }
      legacyByMission.set(missionId,reviews);
    }

    // SQLite cannot ALTER a CHECK constraint. Rebuild only the cycle table,
    // snapshotting and restoring both ON DELETE SET NULL references around
    // the drop. All of this remains inside openDatabase's migration
    // transaction, so any later validation/write failure restores the exact
    // migration-30 schema and data.
    const reviewPointers=db.prepare("SELECT id, review_cycle_id AS cycleId FROM mission_reviews WHERE review_cycle_id IS NOT NULL").all() as {id:string;cycleId:string}[];
    const missionPointers=db.prepare("SELECT id, current_review_cycle_id AS cycleId FROM missions WHERE current_review_cycle_id IS NOT NULL").all() as {id:string;cycleId:string}[];
    db.exec(`
      CREATE TABLE mission_review_cycles_v31 (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','applied','abandoned')),
        reserved_at TEXT NOT NULL,
        resolved_at TEXT,
        owner_id TEXT,
        lease_expires_at TEXT,
        UNIQUE(mission_id, sequence)
      );
      INSERT INTO mission_review_cycles_v31
        (id, mission_id, sequence, status, reserved_at, resolved_at, owner_id, lease_expires_at)
      SELECT id, mission_id, sequence, status, reserved_at, resolved_at,
        CASE WHEN status = 'reserved' THEN 'migration-30-unknown' ELSE NULL END,
        CASE WHEN status = 'reserved' THEN reserved_at ELSE NULL END
      FROM mission_review_cycles;
      DROP TABLE mission_review_cycles;
      ALTER TABLE mission_review_cycles_v31 RENAME TO mission_review_cycles;
      CREATE INDEX mission_review_cycles_mission_idx ON mission_review_cycles(mission_id, sequence);
      CREATE UNIQUE INDEX mission_review_cycles_one_reserved ON mission_review_cycles(mission_id) WHERE status = 'reserved';
    `);
    const restoreReviewPointer=db.prepare("UPDATE mission_reviews SET review_cycle_id = ? WHERE id = ?");
    for(const pointer of reviewPointers) restoreReviewPointer.run(pointer.cycleId,pointer.id);
    const restoreMissionPointer=db.prepare("UPDATE missions SET current_review_cycle_id = ? WHERE id = ?");
    for(const pointer of missionPointers) restoreMissionPointer.run(pointer.cycleId,pointer.id);

    const insertCycle=db.prepare(`INSERT INTO mission_review_cycles
      (id, mission_id, sequence, status, reserved_at, resolved_at, owner_id, lease_expires_at)
      VALUES (?, ?, ?, 'applied', ?, ?, NULL, NULL)`);
    const attachReview=db.prepare("UPDATE mission_reviews SET review_cycle_id = ? WHERE id = ? AND review_cycle_id IS NULL");
    const pointMission=db.prepare("UPDATE missions SET current_review_cycle_id = ? WHERE id = ?");
    for(const [missionId,reviews] of legacyByMission){
      let sequence=(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM mission_review_cycles WHERE mission_id = ?").get(missionId) as {n:number}).n;
      let latestCycleId="";
      for(const review of reviews){
        sequence+=1;
        const cycleId=`legacy-review-cycle-${review.id}`;
        insertCycle.run(cycleId,missionId,sequence,review.createdAt,review.createdAt);
        attachReview.run(cycleId,review.id);
        latestCycleId=cycleId;
      }
      pointMission.run(latestCycleId,missionId);
    }
  }}
  // ── Migration 32 ────────────────────────────────────────────────────────
  // Durable agent execution is append-oriented and separate from the mutable
  // conversation presentation row. Existing tasks require no backfill: their
  // first post-upgrade execution opens segment 1 lazily. A rollback can ignore
  // these additive tables; deleting them loses only resumability metadata, not
  // task, mission, event, conversation, or working-tree records.
  ,{id:32,name:"durable_segmented_execution",sql:`
    CREATE TABLE agent_execution_segments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','checkpointed','completed','failed')),
      boundary_reason TEXT,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      route_json TEXT NOT NULL,
      owner_id TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 1 CHECK(lease_generation > 0),
      lease_expires_at TEXT,
      started_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(task_id, sequence)
    );
    CREATE UNIQUE INDEX agent_execution_segments_one_running
      ON agent_execution_segments(task_id) WHERE status='running';
    CREATE INDEX agent_execution_segments_task_idx
      ON agent_execution_segments(task_id, sequence);

    CREATE TABLE agent_provider_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL REFERENCES agent_execution_segments(id) ON DELETE CASCADE,
      turn_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      assistant_text TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, turn_key),
      UNIQUE(segment_id, ordinal)
    );
    CREATE INDEX agent_provider_turns_task_idx
      ON agent_provider_turns(task_id, segment_id, ordinal);

    CREATE TABLE agent_execution_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      segment_id TEXT NOT NULL REFERENCES agent_execution_segments(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      durable_event_cursor INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, durable_event_cursor)
    );
    CREATE INDEX agent_execution_checkpoints_task_idx
      ON agent_execution_checkpoints(task_id, durable_event_cursor DESC);

    -- Provider-owned continuation is deliberately isolated from checkpoint,
    -- event, conversation, search, and API-facing tables.
    CREATE TABLE agent_provider_continuations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL REFERENCES agent_execution_segments(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      route_fingerprint TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, turn_key)
    );

    CREATE TABLE canonical_task_answers (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX canonical_task_answers_mission_idx
      ON canonical_task_answers(mission_id, created_at) WHERE mission_id IS NOT NULL;
  `}
  // Durable mission control is additive to the existing mission and segmented
  // task ledgers. A rollback may ignore these tables; mission content, task
  // history, and working-tree effects remain in their original stores.
  ,{id:33,name:"durable_mission_runtime",sql:`
    CREATE TABLE mission_runtime (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'created','orienting','planning','executing','validating',
        'waiting_for_tool','waiting_for_approval','recovering','replanning',
        'blocked','completed','cancelled','abandoned','superseded'
      )),
      final_disposition TEXT CHECK(final_disposition IS NULL OR final_disposition IN (
        'blocked','completed','cancelled','abandoned','superseded'
      )),
      active_operation_id TEXT,
      active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      wake_reason TEXT,
      transition_sequence INTEGER NOT NULL DEFAULT 0 CHECK(transition_sequence >= 0),
      operation_sequence INTEGER NOT NULL DEFAULT 0 CHECK(operation_sequence >= 0),
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE mission_runtime_transitions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES mission_runtime(mission_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      cause TEXT NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX mission_runtime_transitions_sequence_uq
      ON mission_runtime_transitions(mission_id, sequence);

    CREATE TABLE mission_operations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES mission_runtime(mission_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending','running','completed','failed','unknown_effect','cancelled'
      )),
      strategy_fingerprint TEXT,
      input_json TEXT NOT NULL,
      result_json TEXT,
      effect_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX mission_operations_sequence_uq
      ON mission_operations(mission_id, sequence);
    CREATE UNIQUE INDEX mission_operations_idempotency_uq
      ON mission_operations(mission_id, idempotency_key);

    CREATE TABLE mission_progress (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES mission_runtime(mission_id) ON DELETE CASCADE,
      operation_id TEXT REFERENCES mission_operations(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      strategy_fingerprint TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_progress_mission_idx
      ON mission_progress(mission_id, created_at, id);

    CREATE TABLE mission_recovery_decisions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES mission_runtime(mission_id) ON DELETE CASCADE,
      operation_id TEXT REFERENCES mission_operations(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      failed_strategy_fingerprint TEXT,
      next_strategy_fingerprint TEXT,
      action TEXT NOT NULL,
      retry_condition TEXT,
      exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX mission_recovery_decisions_mission_idx
      ON mission_recovery_decisions(mission_id, created_at, id);
  `}
  ,{id:34,name:"provider_model_discovery",sql:`
    CREATE TABLE provider_model_discovery (
      provider_id TEXT NOT NULL,
      auth_mode TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available','unavailable')),
      models_json TEXT NOT NULL,
      error_kind TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(provider_id, auth_mode)
    );
  `}
  ,{id:35,name:"automatic_cortex_memory_and_skills",sql:`
    ALTER TABLE memory_entries ADD COLUMN normalized_content TEXT NOT NULL DEFAULT '';
    ALTER TABLE memory_entries ADD COLUMN type TEXT NOT NULL DEFAULT 'project_architecture';
    ALTER TABLE memory_entries ADD COLUMN evidence_references_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE memory_entries ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE memory_entries ADD COLUMN last_verified_at TEXT;
    ALTER TABLE memory_entries ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
    ALTER TABLE memory_entries ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_entries ADD COLUMN success_contribution INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_entries ADD COLUMN failure_contribution INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_entries ADD COLUMN staleness TEXT NOT NULL DEFAULT 'current';
    ALTER TABLE memory_entries ADD COLUMN supersedes_id TEXT;
    ALTER TABLE memory_entries ADD COLUMN conflicts_with_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE memory_entries ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal';
    ALTER TABLE memory_entries ADD COLUMN expiration_policy TEXT NOT NULL DEFAULT 'never';
    ALTER TABLE memory_entries ADD COLUMN expires_at TEXT;
    UPDATE memory_entries SET normalized_content = lower(trim(content)) WHERE normalized_content = '';
    CREATE INDEX memory_entries_lifecycle_idx ON memory_entries(project_id, lifecycle, staleness, enabled);

    CREATE TABLE learned_skills (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      trigger_conditions_json TEXT NOT NULL,
      scope TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      validation_requirements_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      state TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL,
      last_verified_at TEXT,
      rollback_history_json TEXT NOT NULL DEFAULT '[]',
      workflow_fingerprint TEXT NOT NULL,
      directory TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, workflow_fingerprint)
    );
    CREATE INDEX learned_skills_project_state_idx ON learned_skills(project_id, state, updated_at DESC);
  `}
  ,{id:36,name:"durable_mission_execution_route",sql:`
    ALTER TABLE missions ADD COLUMN execution_json TEXT NOT NULL
      DEFAULT '{"preset":"balanced","providerId":null,"model":null,"reasoning":{"mode":"auto"}}';
  `},
  {id:37,name:"mission_idempotency_keys",sql:`
    ALTER TABLE missions ADD COLUMN idempotency_key TEXT;
    CREATE UNIQUE INDEX missions_idempotency_key_idx ON missions(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `}
  ,{id:38,name:"provider_model_discovery_freshness",sql:`
    ALTER TABLE provider_model_discovery ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
    ALTER TABLE provider_model_discovery ADD COLUMN last_success_at TEXT;
    ALTER TABLE provider_model_discovery ADD COLUMN credential_identity TEXT;
    UPDATE provider_model_discovery SET last_success_at=fetched_at WHERE status='available';
  `}
  ,{id:39,name:"task_idempotency_fingerprint",sql:`
    ALTER TABLE tasks ADD COLUMN idempotency_fingerprint TEXT;
  `}
  // ── Migration 40 ────────────────────────────────────────────────────────
  // Artifact-backed externalization for oversized tool results (§3+§4). When
  // a tool result exceeds the inline byte limit, the agent stores the complete
  // content in `tool_artifacts` (durable, hash-indexed for dedup) and
  // references it by id in the next provider request. The agent no longer
  // inlines a 24 KB head/tail fragment into every future turn; instead the
  // model sees a small metadata ref and can `read_artifact` to fetch ranges.
  ,{id:40,name:"tool_artifacts",sql:`
    CREATE TABLE tool_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      tool_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text/plain',
      bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      summary TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content BLOB NOT NULL,
      refcount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX tool_artifacts_task_idx ON tool_artifacts(task_id, created_at DESC);
    CREATE INDEX tool_artifacts_hash_idx ON tool_artifacts(content_hash, kind, content_type);
  `}
  ,{id:41,name:"durable_action_attempts",sql:`
    CREATE TABLE action_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      normalized_signature TEXT NOT NULL,
      command_json TEXT,
      cwd TEXT,
      environment_fingerprint TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','suppressed')),
      exit_status INTEGER,
      termination_reason TEXT,
      failure_category TEXT,
      failure_fingerprint TEXT,
      progress_fingerprint TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(task_id, tool_call_id)
    );
    CREATE INDEX action_attempts_task_idx ON action_attempts(task_id, created_at, id);
    CREATE INDEX action_attempts_mission_signature_idx
      ON action_attempts(mission_id, normalized_signature, attempt_number);
    CREATE INDEX action_attempts_task_signature_idx
      ON action_attempts(task_id, normalized_signature, attempt_number);
  `}
  ,{id:42,name:"mission_terminal_outcome_claims",sql:`
    CREATE TABLE mission_terminal_outcome_claims (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      preserve_status TEXT,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','completed')),
      claimed_at TEXT NOT NULL,
      lease_expires_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX mission_terminal_outcome_claims_lease_idx
      ON mission_terminal_outcome_claims(status, lease_expires_at);
  `}
  ,{id:43,name:"mission_terminal_outcome_verification_state",sql:`
    ALTER TABLE mission_terminal_outcome_claims
      ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(verification_status IN ('pending','running','completed','abandoned'));
  `}
  ,{id:44,name:"mission_terminal_outcome_verification_generation",sql:`
    ALTER TABLE mission_terminal_outcome_claims
      ADD COLUMN verification_generation INTEGER NOT NULL DEFAULT 0;
  `}
  ,{id:45,name:"assistant_message_privacy_boundaries",up(db){
    // The repository boundary protects supported writes; this SQLite function
    // keeps FTS copies safe even for rows written by older versions before the
    // assistant-message privacy contract existed.
    db.exec(`
      DROP TRIGGER IF EXISTS search_msg_ai;
      DROP TRIGGER IF EXISTS search_msg_au;
      CREATE TRIGGER search_msg_ai AFTER INSERT ON conversation_messages BEGIN
        INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
        VALUES('message', new.id,
          (SELECT project_id FROM conversations WHERE id=new.conversation_id),
          new.conversation_id, new.role,
          CASE WHEN new.role='assistant' THEN morrow_redact(new.content) ELSE new.content END,
          new.created_at);
      END;
      CREATE TRIGGER search_msg_au AFTER UPDATE OF content ON conversation_messages BEGIN
        UPDATE search_index
           SET body=CASE WHEN new.role='assistant' THEN morrow_redact(new.content) ELSE new.content END
         WHERE kind='message' AND ref_id=new.id;
      END;
    `);

    const assistants = db.prepare("SELECT id, content FROM conversation_messages WHERE role='assistant'").all() as Array<{ id: string; content: string }>;
    const updateMessage = db.prepare("UPDATE conversation_messages SET content=? WHERE id=?");
    const updateIndex = db.prepare("UPDATE search_index SET body=? WHERE kind='message' AND ref_id=?");
    for (const assistant of assistants) {
      const safeContent = redactSecrets(assistant.content);
      if (safeContent !== assistant.content) updateMessage.run(safeContent, assistant.id);
      updateIndex.run(safeContent, assistant.id);
    }
  }}
  ,{id:46,name:"assistant_message_role_fts_rebuild",up(db){
    // Role changes are privacy-relevant: a user row may become an assistant
    // row without its content changing. Rebuild the message partition so old
    // rows and trigger-managed updates share the same safe projection.
    const assistants = db.prepare("SELECT id, content FROM conversation_messages WHERE role='assistant'").all() as Array<{ id: string; content: string }>;
    const updateMessage = db.prepare("UPDATE conversation_messages SET content=? WHERE id=?");
    for (const assistant of assistants) {
      const safeContent = redactSecrets(assistant.content);
      if (safeContent !== assistant.content) updateMessage.run(safeContent, assistant.id);
    }
    db.exec(`
      DROP TRIGGER IF EXISTS search_msg_ai;
      DROP TRIGGER IF EXISTS search_msg_au;
      CREATE TRIGGER search_msg_ai AFTER INSERT ON conversation_messages BEGIN
        INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
        VALUES('message', new.id,
          (SELECT project_id FROM conversations WHERE id=new.conversation_id),
          new.conversation_id, new.role,
          CASE WHEN new.role='assistant' THEN morrow_redact(new.content) ELSE new.content END,
          new.created_at);
      END;
      CREATE TRIGGER search_msg_au AFTER UPDATE OF content, role ON conversation_messages BEGIN
        UPDATE search_index
           SET title=new.role,
               body=CASE WHEN new.role='assistant' THEN morrow_redact(new.content) ELSE new.content END
         WHERE kind='message' AND ref_id=new.id;
      END;
      DELETE FROM search_index WHERE kind='message';
      INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
        SELECT 'message', m.id, c.project_id, m.conversation_id, m.role,
          CASE WHEN m.role='assistant' THEN morrow_redact(m.content) ELSE m.content END,
          m.created_at
        FROM conversation_messages m
        JOIN conversations c ON c.id=m.conversation_id;
    `);
  }}
  ,{id:47,name:"teams_and_agent_delegation_policy",sql:`
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft','active','paused','archived')),
      shared_memory_policy TEXT NOT NULL CHECK(shared_memory_policy IN ('none','read','read_write')),
      default_max_provider_calls INTEGER,
      default_max_token_budget INTEGER,
      default_max_wall_clock_ms INTEGER,
      default_concurrency_limit INTEGER NOT NULL DEFAULT 1,
      default_approval_required INTEGER NOT NULL DEFAULT 1,
      artifact_policy TEXT NOT NULL CHECK(artifact_policy IN ('workspace_write','verified_only')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX teams_project_idx ON teams(project_id);
    CREATE TABLE team_members (
      schema_version INTEGER NOT NULL,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(team_id, agent_id)
    );
    CREATE INDEX team_members_agent_idx ON team_members(agent_id);

    -- Agent identity/permission profiles gain optional team-delegation fields.
    -- All nullable/defaulted so a standalone agent with no team keeps working
    -- exactly as before (see AgentSchema in packages/contracts).
    ALTER TABLE agents ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
    ALTER TABLE agents ADD COLUMN memory_read_scopes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agents ADD COLUMN memory_write_scopes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agents ADD COLUMN max_provider_calls INTEGER;
    ALTER TABLE agents ADD COLUMN max_token_budget INTEGER;
    ALTER TABLE agents ADD COLUMN max_wall_clock_ms INTEGER;
    ALTER TABLE agents ADD COLUMN max_child_tasks INTEGER;
    ALTER TABLE agents ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agents ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
    CREATE INDEX agents_team_idx ON agents(team_id);
  `}
  ,{id:48,name:"delegations_and_handoffs",sql:`
    CREATE TABLE delegations (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      context_snapshot_ref TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      allowed_memory_scopes_json TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT,
      model TEXT,
      budget_max_provider_calls INTEGER,
      budget_max_token_budget INTEGER,
      budget_max_wall_clock_ms INTEGER,
      approval_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','rejected','running','completed','failed','cancelled')),
      deadline_at TEXT,
      correlation_id TEXT NOT NULL,
      child_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX delegations_parent_task_idx ON delegations(parent_task_id);
    CREATE INDEX delegations_team_idx ON delegations(team_id);
    -- At most one in-flight delegation per child task, enforced durably at
    -- the database level, matching the agent_execution_segments_one_running
    -- reservation pattern.
    CREATE UNIQUE INDEX delegations_one_running_per_child
      ON delegations(child_task_id) WHERE status='running';

    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      result_summary TEXT NOT NULL,
      acceptance_criteria_status_json TEXT NOT NULL DEFAULT '[]',
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      verification_evidence TEXT,
      unresolved_risks_json TEXT NOT NULL DEFAULT '[]',
      source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX handoffs_delegation_idx ON handoffs(delegation_id);
    CREATE INDEX handoffs_task_idx ON handoffs(task_id);
  `}
  ,{id:49,name:"assistant_profile",sql:`
    -- Singleton row: one local, cross-project assistant profile. Enforced by
    -- the CHECK constraint plus repository upsert-only access (never a
    -- client-supplied id).
    CREATE TABLE assistant_profile (
      id TEXT PRIMARY KEY CHECK(id='default'),
      schema_version INTEGER NOT NULL,
      display_name TEXT,
      assistant_name TEXT,
      comms_verbosity TEXT NOT NULL DEFAULT 'concise' CHECK(comms_verbosity IN ('concise','detailed')),
      comms_tone TEXT NOT NULL DEFAULT 'nontechnical' CHECK(comms_tone IN ('technical','nontechnical')),
      timezone TEXT,
      locale TEXT,
      default_provider_id TEXT,
      default_model TEXT,
      default_reasoning_json TEXT NOT NULL DEFAULT '{"mode":"auto"}',
      default_privacy_mode TEXT NOT NULL DEFAULT 'local_only' CHECK(default_privacy_mode IN ('local_only','controlled_cloud','custom')),
      default_approval_posture TEXT NOT NULL DEFAULT 'ask_always' CHECK(default_approval_posture IN ('ask_always','trust_reads','trust_project')),
      goals_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `}
  ,{id:50,name:"durable_tool_context_results",sql:`
    -- Keep the complete tool outcome for operator/API surfaces while also
    -- persisting the bounded representation that was actually shown to the
    -- model. Reconstructing a request after a restart must not re-inject the
    -- unbounded raw result or manufacture a different synthetic outcome.
    ALTER TABLE message_tool_calls ADD COLUMN context_result_json TEXT;
  `}
  ,{id:51,name:"task_evidence_task_id_index",sql:`
    -- Evidence is appended on every workspace read and listed per task, but
    -- task_evidence had no index on task_id: both the per-task listing and the
    -- per-task COUNT(*) in the task list endpoint fell back to a full scan of
    -- every evidence row the install has ever recorded. Index entries are
    -- ordered by (task_id, created_at, rowid), which is exactly the listing's
    -- ORDER BY, so the sort is served by the index too.
    CREATE INDEX IF NOT EXISTS task_evidence_task_id_created_at_idx ON task_evidence(task_id,created_at);
  `}
  ,{id:52,name:"conversation_agent_binding",sql:`
    -- A conversation is a thread with one teammate. Binding the agent here
    -- rather than re-deriving it from the tasks inside means the thread keeps
    -- its owner before the first message is ever sent, and an agent that is
    -- later deleted leaves its history readable under the default teammate
    -- instead of taking the conversation with it.
    ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS conversations_agent_idx ON conversations(agent_id,updated_at DESC);
    -- The roster's per-teammate status reads live task state by agent. Without
    -- this every roster render scans the whole task table once per teammate.
    CREATE INDEX IF NOT EXISTS tasks_agent_status_idx ON tasks(agent_id,status);
  `}
  ,{id:53,name:"routines_and_recordings",sql:`
    -- "Watch me do this once." A recording is an explicit, opt-in span of one
    -- thread; a routine is what the user chose to keep from it.
    CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      objective TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX routines_project_idx ON routines(project_id,updated_at DESC);

    CREATE TABLE routine_recordings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL
    );
    -- One open recording per thread, enforced durably rather than by whichever
    -- client happened to ask last.
    CREATE UNIQUE INDEX routine_recordings_one_open_per_conversation
      ON routine_recordings(conversation_id) WHERE stopped_at IS NULL;
    CREATE INDEX routine_recordings_conversation_idx ON routine_recordings(conversation_id,started_at DESC);
  `}
  ,{id:54,name:"durable_routine_schedules_and_runs",sql:`
    -- Schedules predating routine automation remain inspect_workspace rows.
    -- The target columns are additive so an older install is never rebuilt or
    -- downgraded; routine schedules bind a routine and the teammate observed
    -- when it was created, while dispatch still re-checks today's policy.
    ALTER TABLE schedules ADD COLUMN routine_id TEXT;
    ALTER TABLE schedules ADD COLUMN agent_id TEXT;
    ALTER TABLE schedules ADD COLUMN updated_at TEXT;
    UPDATE schedules SET updated_at=created_at WHERE updated_at IS NULL;
    CREATE INDEX schedules_routine_idx ON schedules(routine_id);

    -- One row records one claimed occurrence. schedule_id intentionally has no
    -- foreign key: deleting a schedule must not erase its audit history.
    -- project_id is retained for scoped history even if the target routine is
    -- later removed. occurrence_key is the durable idempotency boundary.
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      routine_id TEXT,
      occurrence_at TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT,
      error_code TEXT,
      error_message TEXT,
      coalesced INTEGER NOT NULL DEFAULT 0,
      routine_run_recorded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX schedule_runs_occurrence_idx ON schedule_runs(schedule_id,occurrence_key);
    CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id,created_at DESC,id DESC);
    CREATE INDEX schedule_runs_project_idx ON schedule_runs(project_id,created_at DESC,id DESC);
    CREATE INDEX schedule_runs_task_idx ON schedule_runs(task_id) WHERE task_id IS NOT NULL;
  `}
  ,{id:55,name:"memory_teammate_ownership",sql:`
    -- Private memory is owned by the durable teammate identity (or its team),
    -- never by a client-supplied label. Nullable columns preserve the
    -- project/global rows that intentionally have no private owner.
    ALTER TABLE memory_entries ADD COLUMN owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
    ALTER TABLE memory_entries ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
    CREATE INDEX memory_entries_owner_agent_idx ON memory_entries(project_id,owner_agent_id,scope);
    CREATE INDEX memory_entries_owner_team_idx ON memory_entries(project_id,owner_team_id,scope);

    -- A legacy private row is safe to retain only when its origin task and
    -- conversation agree on the same enabled teammate. Team ownership is
    -- derived from that teammate's durable team membership. Rows without an
    -- exact proof are quarantined (disabled) but remain user-visible for
    -- inspection/deletion; no transcript content is copied or synthesized.
    UPDATE memory_entries
       SET owner_agent_id=(
         SELECT t.agent_id
           FROM tasks t
           JOIN conversations c ON c.id=memory_entries.conversation_id
           JOIN agents a ON a.id=t.agent_id
          WHERE t.id=memory_entries.origin_task_id
            AND t.project_id=memory_entries.project_id
            AND c.project_id=memory_entries.project_id
            AND t.agent_id IS NOT NULL
           AND c.agent_id=t.agent_id
           AND (a.team_id IS NULL OR EXISTS (
             SELECT 1 FROM team_members tm JOIN teams active_team ON active_team.id=tm.team_id
              WHERE tm.team_id=a.team_id AND tm.agent_id=a.id AND active_team.status='active'
           ))
       )
     WHERE scope='agent'
       AND origin_task_id IS NOT NULL
       AND conversation_id IS NOT NULL;
    UPDATE memory_entries
       SET owner_team_id=(
         SELECT a.team_id
           FROM tasks t
           JOIN conversations c ON c.id=memory_entries.conversation_id
           JOIN agents a ON a.id=t.agent_id
           JOIN teams tm ON tm.id=a.team_id
          WHERE t.id=memory_entries.origin_task_id
            AND t.project_id=memory_entries.project_id
            AND c.project_id=memory_entries.project_id
            AND t.agent_id IS NOT NULL
            AND c.agent_id=t.agent_id
            AND a.enabled<>0
            AND EXISTS (SELECT 1 FROM team_members tmbr WHERE tmbr.team_id=a.team_id AND tmbr.agent_id=a.id)
            AND tm.status='active'
            AND a.team_id IS NOT NULL
       )
     WHERE scope='team'
       AND origin_task_id IS NOT NULL
       AND conversation_id IS NOT NULL;
    UPDATE memory_entries
       SET enabled=0
     WHERE (scope='agent' AND owner_agent_id IS NULL)
        OR (scope='team' AND owner_team_id IS NULL);
    UPDATE memory_entries SET enabled=0
      WHERE scope='agent' AND owner_agent_id IN (SELECT id FROM agents WHERE enabled=0);

    -- Enforce the shape at the database boundary too. Disabled ownerless
    -- private rows are the deliberate quarantine state for ambiguous legacy
    -- data and for deleted/disabled owners.
    CREATE TRIGGER memory_entries_ownership_insert
      BEFORE INSERT ON memory_entries
      WHEN (NEW.scope='agent' AND NEW.owner_agent_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='team' AND NEW.owner_team_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='agent' AND NEW.owner_team_id IS NOT NULL)
        OR (NEW.scope='team' AND NEW.owner_agent_id IS NOT NULL)
        OR (NEW.scope NOT IN ('agent','team') AND (NEW.owner_agent_id IS NOT NULL OR NEW.owner_team_id IS NOT NULL))
      BEGIN
        SELECT RAISE(ABORT,'memory ownership does not match scope');
      END;
    CREATE TRIGGER memory_entries_ownership_update
      BEFORE UPDATE OF scope,owner_agent_id,owner_team_id,enabled ON memory_entries
      WHEN (NEW.scope='agent' AND NEW.owner_agent_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='team' AND NEW.owner_team_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='agent' AND NEW.owner_team_id IS NOT NULL)
        OR (NEW.scope='team' AND NEW.owner_agent_id IS NOT NULL)
        OR (NEW.scope NOT IN ('agent','team') AND (NEW.owner_agent_id IS NOT NULL OR NEW.owner_team_id IS NOT NULL))
      BEGIN
        SELECT RAISE(ABORT,'memory ownership does not match scope');
      END;

    -- Deleting an owner never silently reactivates private knowledge. The
    -- owner id is then nulled by the FK action, leaving a truthful disabled
    -- orphan row in the user's vault.
    CREATE TRIGGER memory_entries_quarantine_deleted_agent
      BEFORE DELETE ON agents
      BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='agent' AND owner_agent_id=OLD.id;
      END;
    CREATE TRIGGER memory_entries_quarantine_disabled_agent
      AFTER UPDATE OF enabled ON agents
      WHEN NEW.enabled=0 AND OLD.enabled<>0
      BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='agent' AND owner_agent_id=NEW.id;
      END;
    CREATE TRIGGER memory_entries_quarantine_deleted_team
      BEFORE DELETE ON teams
      BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='team' AND owner_team_id=OLD.id;
      END;
    CREATE TRIGGER memory_entries_quarantine_inactive_team
      AFTER UPDATE OF status ON teams
      WHEN NEW.status<>'active' AND OLD.status='active'
      BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='team' AND owner_team_id=NEW.id;
      END;
  `}
  ,{id:56,name:"schedule_recovery_leases",up:(db:Database.Database)=>{
    const columns=new Set((db.prepare("PRAGMA table_info(schedule_runs)").all()as Array<{name:string}>).map(column=>column.name));
    if(!columns.has("recovery_owner"))db.exec("ALTER TABLE schedule_runs ADD COLUMN recovery_owner TEXT");
    if(!columns.has("recovery_lease_expires_at"))db.exec("ALTER TABLE schedule_runs ADD COLUMN recovery_lease_expires_at TEXT");
    if(!columns.has("recovery_attempts"))db.exec("ALTER TABLE schedule_runs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS schedule_runs_recovery_idx ON schedule_runs(status,recovery_lease_expires_at,created_at,id)");
  }}
  ,{id:57,name:"memory_global_survives_project_deletion",up:(db:Database.Database)=>{
    // 55/56 are immutable. Rebuild only the memory table to remove the
    // project cascade: user_global rows retain their provenance project id,
    // while a project-delete trigger removes every other memory row.
    db.exec(`
      DROP TRIGGER IF EXISTS memory_entries_ownership_insert;
      DROP TRIGGER IF EXISTS memory_entries_ownership_update;
      DROP TRIGGER IF EXISTS memory_entries_quarantine_deleted_agent;
      DROP TRIGGER IF EXISTS memory_entries_quarantine_disabled_agent;
      DROP TRIGGER IF EXISTS memory_entries_quarantine_deleted_team;
      DROP TRIGGER IF EXISTS memory_entries_quarantine_inactive_team;
      DROP TRIGGER IF EXISTS search_mem_ai;
      DROP TRIGGER IF EXISTS search_mem_au;
      DROP TRIGGER IF EXISTS search_mem_ad;
      DROP INDEX IF EXISTS memory_entries_project_idx;
      DROP INDEX IF EXISTS memory_entries_conversation_idx;
      DROP INDEX IF EXISTS memory_entries_origin_idx;
      DROP INDEX IF EXISTS memory_entries_lifecycle_idx;
      DROP INDEX IF EXISTS memory_entries_owner_agent_idx;
      DROP INDEX IF EXISTS memory_entries_owner_team_idx;
      ALTER TABLE memory_entries RENAME TO memory_entries_55;
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        normalized_content TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'project_architecture',
        evidence_references_json TEXT NOT NULL DEFAULT '[]',
        lifecycle TEXT NOT NULL DEFAULT 'active',
        last_verified_at TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        usage_count INTEGER NOT NULL DEFAULT 0,
        success_contribution INTEGER NOT NULL DEFAULT 0,
        failure_contribution INTEGER NOT NULL DEFAULT 0,
        staleness TEXT NOT NULL DEFAULT 'current',
        supersedes_id TEXT,
        conflicts_with_ids_json TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        expiration_policy TEXT NOT NULL DEFAULT 'never',
        expires_at TEXT,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        owner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL
      );
      INSERT INTO memory_entries
        SELECT id,project_id,
          CASE WHEN scope='user_global' THEN NULL ELSE conversation_id END,
          scope,content,source,enabled,created_at,updated_at,pinned,origin_task_id,
          normalized_content,type,evidence_references_json,lifecycle,last_verified_at,
          confidence,usage_count,success_contribution,failure_contribution,staleness,
          supersedes_id,conflicts_with_ids_json,sensitivity,expiration_policy,expires_at,
          owner_agent_id,owner_team_id
        FROM memory_entries_55;
      DROP TABLE memory_entries_55;
      CREATE INDEX memory_entries_project_idx ON memory_entries(project_id);
      CREATE INDEX memory_entries_conversation_idx ON memory_entries(conversation_id);
      CREATE INDEX memory_entries_origin_idx ON memory_entries(origin_task_id);
      CREATE INDEX memory_entries_lifecycle_idx ON memory_entries(project_id,lifecycle,staleness,enabled);
      CREATE INDEX memory_entries_owner_agent_idx ON memory_entries(project_id,owner_agent_id,scope);
      CREATE INDEX memory_entries_owner_team_idx ON memory_entries(project_id,owner_team_id,scope);

      CREATE TRIGGER memory_entries_ownership_insert BEFORE INSERT ON memory_entries
      WHEN (NEW.scope='agent' AND NEW.owner_agent_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='team' AND NEW.owner_team_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='agent' AND NEW.owner_team_id IS NOT NULL)
        OR (NEW.scope='team' AND NEW.owner_agent_id IS NOT NULL)
        OR (NEW.scope NOT IN ('agent','team') AND (NEW.owner_agent_id IS NOT NULL OR NEW.owner_team_id IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'memory ownership does not match scope'); END;
      CREATE TRIGGER memory_entries_ownership_update BEFORE UPDATE OF scope,owner_agent_id,owner_team_id,enabled ON memory_entries
      WHEN (NEW.scope='agent' AND NEW.owner_agent_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='team' AND NEW.owner_team_id IS NULL AND NEW.enabled<>0)
        OR (NEW.scope='agent' AND NEW.owner_team_id IS NOT NULL)
        OR (NEW.scope='team' AND NEW.owner_agent_id IS NOT NULL)
        OR (NEW.scope NOT IN ('agent','team') AND (NEW.owner_agent_id IS NOT NULL OR NEW.owner_team_id IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'memory ownership does not match scope'); END;
      CREATE TRIGGER memory_entries_quarantine_deleted_agent BEFORE DELETE ON agents BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='agent' AND owner_agent_id=OLD.id;
      END;
      CREATE TRIGGER memory_entries_quarantine_disabled_agent AFTER UPDATE OF enabled ON agents
      WHEN NEW.enabled=0 AND OLD.enabled<>0 BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='agent' AND owner_agent_id=NEW.id;
      END;
      CREATE TRIGGER memory_entries_quarantine_deleted_team BEFORE DELETE ON teams BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='team' AND owner_team_id=OLD.id;
      END;
      CREATE TRIGGER memory_entries_quarantine_inactive_team AFTER UPDATE OF status ON teams
      WHEN NEW.status<>'active' AND OLD.status='active' BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='team' AND owner_team_id=NEW.id;
        UPDATE delegations SET status='rejected',updated_at=NEW.updated_at
          WHERE team_id=NEW.id AND status IN ('pending_approval','approved','running');
      END;
      CREATE TRIGGER memory_entries_quarantine_removed_member AFTER DELETE ON team_members BEGIN
        UPDATE memory_entries SET enabled=0 WHERE scope='team' AND owner_team_id=OLD.team_id;
        UPDATE delegations SET status='rejected',updated_at=datetime('now')
          WHERE team_id=OLD.team_id AND agent_id=OLD.agent_id
            AND status IN ('pending_approval','approved','running');
      END;
      CREATE TRIGGER memory_entries_project_delete BEFORE DELETE ON projects BEGIN
        DELETE FROM memory_entries WHERE project_id=OLD.id AND scope<>'user_global';
        UPDATE search_index SET project_id=NULL WHERE kind='memory' AND project_id=OLD.id AND title='user_global';
      END;
      CREATE TRIGGER memory_entries_conversation_delete BEFORE DELETE ON conversations BEGIN
        DELETE FROM memory_entries WHERE conversation_id=OLD.id AND scope<>'user_global';
        UPDATE memory_entries SET conversation_id=NULL WHERE conversation_id=OLD.id AND scope='user_global';
        UPDATE search_index SET conversation_id=NULL WHERE kind='memory' AND conversation_id=OLD.id AND title='user_global';
      END;
      CREATE TRIGGER search_mem_ai AFTER INSERT ON memory_entries BEGIN
        INSERT INTO search_index(kind,ref_id,project_id,conversation_id,title,body,created_at)
        VALUES('memory',new.id,new.project_id,new.conversation_id,new.scope,new.content,new.created_at);
      END;
      CREATE TRIGGER search_mem_au AFTER UPDATE OF content ON memory_entries BEGIN
        UPDATE search_index SET body=new.content WHERE kind='memory' AND ref_id=new.id;
      END;
      CREATE TRIGGER search_mem_ad AFTER DELETE ON memory_entries BEGIN
        DELETE FROM search_index WHERE kind='memory' AND ref_id=old.id;
      END;
    `);
  }}
];
/**
 * Durability mode for committed writes.
 *
 * Under WAL, `synchronous = NORMAL` fsyncs at checkpoints rather than at every
 * commit. A crashed Morrow process — the failure this database exists to
 * survive — loses nothing, because the WAL is already on the OS's side of the
 * boundary; only an OS crash or power loss can drop the most recent commits,
 * and the database is never corrupted either way. `NORMAL` measures 7x faster
 * than `FULL` on the durable write path (0.71ms -> 0.10ms per event on SSD),
 * and a task emits thousands of events.
 *
 * This is stated explicitly rather than inherited, because what was inherited
 * depended on the open. better-sqlite3's SQLite is built with
 * SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so opening an already-WAL database quietly
 * yielded `NORMAL`; only the first open of a fresh database ran `FULL`, because
 * `journal_mode = WAL` is applied after the connection has already defaulted.
 * A durability mode should not depend on whether the file existed yet.
 * Set MORROW_SQLITE_SYNCHRONOUS=FULL to opt back in.
 */
function synchronousMode(env:NodeJS.ProcessEnv):"OFF"|"NORMAL"|"FULL"|"EXTRA"{
  const requested=(env.MORROW_SQLITE_SYNCHRONOUS??"").trim().toUpperCase();
  return requested==="OFF"||requested==="NORMAL"||requested==="FULL"||requested==="EXTRA"?requested:"NORMAL";
}

/**
 * Compiling SQL is not free (~5us per call) and this codebase issues the same
 * few hundred statements over and over — twice per durable event, and many
 * times per projection rebuild. better-sqlite3 statements are reusable on their
 * connection, so `prepare` is memoized by SQL text.
 *
 * Two deliberate exclusions keep this transparent: PRAGMA statements are never
 * cached (they are one-shot, and the single caller that uses one reconfigures
 * the statement with `.pluck()`), and the cache is bounded so the handful of
 * call sites that build SQL from a variable column or placeholder list cannot
 * grow it without limit.
 */
const MAX_CACHED_STATEMENTS=512;

function installStatementCache(db:Database.Database):void{
  const compile=db.prepare.bind(db);
  const cache=new Map<string,Database.Statement>();
  Object.defineProperty(db,"prepare",{
    configurable:true,
    writable:true,
    value:(sql:string)=>{
      if(typeof sql!=="string"||/^\s*pragma\b/i.test(sql))return compile(sql);
      const cached=cache.get(sql);
      if(cached!==undefined)return cached;
      const statement=compile(sql);
      if(cache.size>=MAX_CACHED_STATEMENTS){
        const oldest=cache.keys().next();
        if(!oldest.done)cache.delete(oldest.value);
      }
      cache.set(sql,statement);
      return statement;
    },
  });
}

export function openDatabase(file:string,env:NodeJS.ProcessEnv=process.env){
  if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});
  const db=new Database(file);
  try{
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (file !== ":memory:") {
      db.pragma("journal_mode = WAL");
      db.pragma(`synchronous = ${synchronousMode(env)}`);
      // Checkpoint on a larger WAL so a long task is not interrupted by a
      // synchronous checkpoint every few hundred events.
      db.pragma("wal_autocheckpoint = 2000");
    }
    // 64 MB page cache and memory-backed temp objects: the read-heavy
    // projections rebuild whole conversations, and paging those from disk on
    // every rebuild is the difference between a warm and a cold projection.
    db.pragma("cache_size = -65536");
    db.pragma("temp_store = MEMORY");
    db.function("morrow_redact", { deterministic: true }, (value: unknown) => typeof value === "string" ? redactSecrets(value) : "");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const applied=new Set((db.prepare("SELECT id FROM schema_migrations").all()as{id:number}[]).map(x=>x.id));
    for(const m of migrations){
      if(applied.has(m.id))continue;
      db.transaction(()=>{
        if(m.sql)db.exec(m.sql);
        if(m.up)m.up(db);
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(m.id,m.name,new Date().toISOString());
      })();
    }
    const newest=(db.prepare("SELECT MAX(id) id FROM schema_migrations").get()as{id:number|null}).id;
    if(newest!==null&&newest>migrations.at(-1)!.id)throw new Error("Database schema is newer than this application");
    // Installed only after migrations: statements compiled against a schema
    // that a later migration rewrites must never be reused.
    installStatementCache(db);
    return db;
  }catch(error){
    db.close();
    throw error;
  }
}
