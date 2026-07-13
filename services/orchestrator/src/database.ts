import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
];
export function openDatabase(file:string){if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});const db=new Database(file);db.pragma("foreign_keys = ON");db.pragma("busy_timeout = 5000");db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");const applied=new Set((db.prepare("SELECT id FROM schema_migrations").all()as{id:number}[]).map(x=>x.id));for(const m of migrations){if(applied.has(m.id))continue;db.transaction(()=>{if(m.sql)db.exec(m.sql);if(m.up)m.up(db);db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(m.id,m.name,new Date().toISOString())})()}const newest=(db.prepare("SELECT MAX(id) id FROM schema_migrations").get()as{id:number|null}).id;if(newest!==null&&newest>migrations.at(-1)!.id)throw new Error("Database schema is newer than this application");return db}
