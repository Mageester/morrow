import type Database from "better-sqlite3";
import { ConversationSchema, ConversationMessageSchema, type Conversation, type ConversationMessage } from "@morrow/contracts";
import { redactJsonText, redactSecrets } from "../provider/credentials.js";
import { externalizeToolResult, renderExternalizedForContext } from "../execution/artifact-externalization.js";
import { toolArtifactsRepository } from "./tool-artifacts.js";
import { conversationsParticipantsRepository } from "./conversation-participants.js";

function safeErrorText(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : redactSecrets(value).slice(0, 2_000);
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function deriveContextResult(
  db: Database.Database,
  input: { taskId: string; toolName: string; resultJson: string; now: string },
): string {
  const externalized = externalizeToolResult(toolArtifactsRepository(db), input.resultJson, {
    taskId: input.taskId,
    toolName: input.toolName,
    // Keep this kind aligned with the live agent path so legacy reconstruction
    // deduplicates against an artifact already created during execution.
    kind: input.toolName,
    contentType: "application/json",
    now: input.now,
  });
  return renderExternalizedForContext(externalized);
}

export interface ToolCallRecord {
  id: string;
  messageId: string;
  taskId: string;
  toolName: string;
  argsJson: string;
  resultJson?: string | null;
  /** Bounded result/reference used in the next provider request. */
  contextResultJson?: string | null;
  status: "requested" | "running" | "completed" | "failed" | "cancelled";
  errorType?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export function conversationsRepository(db: Database.Database) {
  const mapConversation = (row: any): Conversation => {
    return ConversationSchema.parse({
      version: 1,
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      archived: Number(row.archived ?? 0) !== 0,
      agentId: row.agent_id ?? null,
      mode: row.mode ?? "single",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  };

  const mapMessage = (row: any): ConversationMessage => {
    return ConversationMessageSchema.parse({
      version: 1,
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.role === "assistant" ? redactSecrets(row.content) : row.content,
      taskId: row.task_id,
      streamingState: row.streaming_state,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  };

  const mapToolCall = (row: any): ToolCallRecord => {
    return {
      id: row.id,
      messageId: row.message_id,
      taskId: row.task_id,
      toolName: row.tool_name,
      argsJson: redactJsonText(row.args_json) ?? "{}",
      resultJson: row.result_json === null || row.result_json === undefined ? row.result_json : redactJsonText(row.result_json),
      contextResultJson: row.context_result_json === null || row.context_result_json === undefined ? row.context_result_json : redactJsonText(row.context_result_json),
      status: row.status,
      errorType: safeErrorText(row.error_type),
      errorMessage: safeErrorText(row.error_message),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  };

  return {
    createConversation(
      input: Omit<Conversation, "version" | "archived" | "agentId" | "mode"> & { archived?: boolean; agentId?: string | null; mode?: Conversation["mode"] },
    ): Conversation {
      if (input.mode === "group" && input.agentId) {
        const conductor = db.prepare("SELECT team_id FROM agents WHERE id=? AND project_id=?").get(input.agentId, input.projectId) as { team_id: string | null } | undefined;
        if (conductor?.team_id) {
          const error = new Error("Team agents must be started through the delegation API");
          Object.assign(error, { code: "TEAM_AGENT_REQUIRES_DELEGATION" });
          throw error;
        }
      }
      db.prepare(
        "INSERT INTO conversations (id, project_id, title, agent_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(input.id, input.projectId, input.title, input.agentId ?? null, input.mode ?? "single", input.createdAt, input.updatedAt);
      if (input.mode === "group" && input.agentId) {
        const agent = db.prepare("SELECT * FROM agents WHERE id=? AND project_id=?").get(input.agentId, input.projectId) as any;
        if (agent) conversationsParticipantsRepository(db).ensureConductor(input.id, input.projectId, {
          version: 1,
          id: String(agent.id), projectId: String(agent.project_id), name: String(agent.name), role: agent.role,
          instructions: agent.instructions ?? null, providerOverride: agent.provider_override ?? null,
          modelOverride: agent.model_override ?? null, enabled: Boolean(agent.enabled), teamId: agent.team_id ?? null,
          memoryReadScopes: JSON.parse(String(agent.memory_read_scopes_json ?? "[]")),
          memoryWriteScopes: JSON.parse(String(agent.memory_write_scopes_json ?? "[]")),
          maxProviderCalls: agent.max_provider_calls ?? null, maxTokenBudget: agent.max_token_budget ?? null,
          maxWallClockMs: agent.max_wall_clock_ms ?? null, maxChildTasks: agent.max_child_tasks ?? null,
          approvalRequired: Boolean(agent.approval_required), createdBy: agent.created_by ?? "user",
          createdAt: String(agent.created_at), updatedAt: String(agent.updated_at),
        }, input.createdAt);
      }
      return this.getConversation(input.id)!;
    },

    getConversation(id: string): Conversation | undefined {
      const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
      return row ? mapConversation(row) : undefined;
    },

    listConversationsByProject(projectId: string, includeArchived = false): Conversation[] {
      const sql = includeArchived
        ? "SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC"
        : "SELECT * FROM conversations WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC";
      return db.prepare(sql).all(projectId).map(mapConversation);
    },

    listConversationsByAgent(projectId: string, agentId: string | null, includeArchived = false): Conversation[] {
      const archivedClause = includeArchived ? "" : " AND archived = 0";
      const sql = agentId === null
        ? `SELECT * FROM conversations WHERE project_id = ? AND agent_id IS NULL${archivedClause} ORDER BY updated_at DESC`
        : `SELECT * FROM conversations WHERE project_id = ? AND agent_id = ?${archivedClause} ORDER BY updated_at DESC`;
      const rows = agentId === null
        ? db.prepare(sql).all(projectId)
        : db.prepare(sql).all(projectId, agentId);
      return rows.map(mapConversation);
    },

    renameConversation(id: string, title: string, updatedAt: string): Conversation | undefined {
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, id);
      return this.getConversation(id);
    },

    setArchived(id: string, archived: boolean, updatedAt: string): Conversation | undefined {
      db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, updatedAt, id);
      return this.getConversation(id);
    },

    setMode(id: string, mode: Conversation["mode"], updatedAt: string): Conversation | undefined {
      db.prepare("UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?").run(mode, updatedAt, id);
      return this.getConversation(id);
    },

    deleteConversation(id: string, projectId: string):
      | { outcome: "deleted" }
      | { outcome: "not_found" }
      | { outcome: "project_mismatch" }
      | { outcome: "active_task"; taskIds: string[] } {
      return db.transaction(() => {
        const conversation = this.getConversation(id);
        if (!conversation) return { outcome: "not_found" } as const;
        if (conversation.projectId !== projectId) return { outcome: "project_mismatch" } as const;

        const active = db.prepare(
          `SELECT DISTINCT tasks.id
           FROM tasks
           INNER JOIN conversation_messages ON conversation_messages.task_id = tasks.id
           WHERE conversation_messages.conversation_id = ?
             AND tasks.status IN ('queued', 'running')
           ORDER BY tasks.id ASC`
        ).all(id) as Array<{ id: string }>;
        if (active.length > 0) {
          return { outcome: "active_task", taskIds: active.map((task) => task.id) } as const;
        }

        db.prepare("DELETE FROM conversations WHERE id = ? AND project_id = ?").run(id, projectId);
        return { outcome: "deleted" } as const;
      })();
    },

    appendMessage(input: {
      id: string;
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      taskId?: string | null;
      streamingState?: "queued" | "streaming" | "completed" | "failed" | "cancelled" | "interrupted";
      provider?: string | null;
      model?: string | null;
      createdAt: string;
      updatedAt: string;
    }): ConversationMessage {
      const safeContent = input.role === "assistant" ? redactSecrets(input.content) : input.content;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO conversation_messages 
           (id, conversation_id, role, content, task_id, streaming_state, provider, model, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.id,
          input.conversationId,
          input.role,
          safeContent,
          input.taskId || null,
          input.streamingState || "completed",
          input.provider || null,
          input.model || null,
          input.createdAt,
          input.updatedAt
        );
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(input.updatedAt, input.conversationId);
      })();
      return this.getMessage(input.id)!;
    },

    getMessage(id: string): ConversationMessage | undefined {
      const row = db.prepare("SELECT * FROM conversation_messages WHERE id = ?").get(id);
      return row ? mapMessage(row) : undefined;
    },

    listMessages(conversationId: string): ConversationMessage[] {
      return db
        .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(conversationId)
        .map(mapMessage);
    },

    /** The one group-conversation lookup for a task. Every caller (ask_teammate
     * parsing, roster projection, dispatch) must agree on the same row, so the
     * join lives here with deterministic ordering instead of being re-typed
     * per site. Returns undefined for non-group or conversationless tasks. */
    groupContextForTask(taskId: string): { conversationId: string; mode: string } | undefined {
      const row = db.prepare(
        `SELECT c.id AS conversation_id, c.mode
         FROM conversations c
         INNER JOIN conversation_messages m ON m.conversation_id = c.id
         WHERE m.task_id = ?
         ORDER BY m.rowid ASC
         LIMIT 1`,
      ).get(taskId) as { conversation_id?: string; mode?: string } | undefined;
      if (!row?.conversation_id || !row.mode) return undefined;
      return { conversationId: row.conversation_id, mode: row.mode };
    },

    isActiveGroupParticipant(conversationId: string, agentId: string): boolean {
      return Boolean(db.prepare(
        "SELECT 1 FROM conversation_participants WHERE conversation_id=? AND agent_id=? AND role='participant' AND status='active' LIMIT 1",
      ).get(conversationId, agentId));
    },

    updateMessageContentAndState(id: string, content: string, streamingState: string, updatedAt: string): ConversationMessage {
      // One scalar read for both decisions. `conversation_id` is immutable for
      // a message, so reading it before the update is equivalent to the row
      // re-read this used to do afterwards — and it avoids parsing the whole
      // message (including the content just written) on a path that runs for
      // every flush of a streaming response.
      const current = db.prepare("SELECT role, conversation_id FROM conversation_messages WHERE id = ?").get(id) as { role: string; conversation_id: string } | undefined;
      const safeContent = current?.role === "assistant" ? redactSecrets(content) : content;
      db.transaction(() => {
        db.prepare(
          "UPDATE conversation_messages SET content = ?, streaming_state = ?, updated_at = ? WHERE id = ?"
        ).run(safeContent, streamingState, updatedAt, id);
        if (current) {
          db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, current.conversation_id);
        }
      })();
      return this.getMessage(id)!;
    },

    upsertToolCall(input: {
      id: string;
      messageId: string;
      taskId: string;
      toolName: string;
      argsJson: string;
      resultJson?: string | null;
      contextResultJson?: string | null;
      status: "requested" | "running" | "completed" | "failed" | "cancelled";
      errorType?: string | null;
      errorMessage?: string | null;
      createdAt: string;
      startedAt?: string | null;
      completedAt?: string | null;
    }): ToolCallRecord {
      // This table is keyed globally on the tool-call id, and the conflicting
      // update below deliberately refreshes only lifecycle fields — a call
      // legitimately upserts several times as it moves requested -> running ->
      // completed, and the name and arguments recorded on the first write are
      // the truth. That makes an id COLLISION between two different tasks
      // indistinguishable from a normal lifecycle update, and silent: the
      // second task's call updates the first task's row and is never recorded
      // at all. That is exactly what happened when the Gemini adapter minted
      // per-turn ordinal ids ("gemini-tool-0"), and every Gemini conversation
      // after the first showed zero tool calls.
      //
      // A tool-call id is unique per task by construction, so a write landing
      // on another task's row is a defect in whatever minted the id — never a
      // recoverable condition. Refuse it loudly instead of losing the data.
      db.transaction(() => {
        const existing = db
          .prepare("SELECT task_id, result_json, context_result_json FROM message_tool_calls WHERE id = ?")
          .get(input.id) as { task_id: string; result_json: string | null; context_result_json: string | null } | undefined;
        if (existing && existing.task_id !== input.taskId) {
          throw new Error(
            `Tool-call id collision: "${input.id}" is already recorded under task ${existing.task_id} and cannot be rewritten by task ${input.taskId}. Tool-call ids must be unique per task; the provider adapter that minted the id is reusing it across streams.`
          );
        }
        const safeArgsJson = redactJsonText(input.argsJson) ?? "{}";
        const safeResultJson = input.resultJson === null || input.resultJson === undefined
          ? null
          : redactJsonText(input.resultJson) ?? "null";
        let safeContextResultJson = input.contextResultJson === null || input.contextResultJson === undefined
          ? null
          : redactJsonText(input.contextResultJson) ?? "null";
        // Older rows have the complete operator-facing result but no context
        // projection. Materialize that projection at the persistence seam so
        // every later request/restart sees the same bounded value. This runs in
        // the same SQLite transaction as the terminal row write, including the
        // artifact insert/refcount update.
        if (safeContextResultJson === null
          && TERMINAL_TOOL_STATUSES.has(input.status)
          && !(existing?.context_result_json)
        ) {
          const sourceResult = safeResultJson ?? existing?.result_json ?? null;
          if (sourceResult !== null) {
            safeContextResultJson = deriveContextResult(db, {
              taskId: input.taskId,
              toolName: input.toolName,
              resultJson: sourceResult,
              now: input.completedAt ?? input.createdAt,
            });
          }
        }
        db.prepare(
          `INSERT INTO message_tool_calls
           (id, message_id, task_id, tool_name, args_json, result_json, context_result_json, status, error_type, error_message, created_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             result_json = COALESCE(excluded.result_json, result_json),
             context_result_json = COALESCE(excluded.context_result_json, context_result_json),
             status = excluded.status,
             error_type = excluded.error_type,
             error_message = excluded.error_message,
             started_at = COALESCE(excluded.started_at, started_at),
             completed_at = COALESCE(excluded.completed_at, completed_at)`
        ).run(
          input.id,
          input.messageId,
          input.taskId,
          input.toolName,
          safeArgsJson,
          safeResultJson,
          safeContextResultJson,
          input.status,
          safeErrorText(input.errorType) || null,
          safeErrorText(input.errorMessage) || null,
          input.createdAt,
          input.startedAt || null,
          input.completedAt || null
        );
      })();
      return this.getToolCall(input.id)!;
    },

    /**
     * Repair legacy terminal rows that predate context_result_json. The
     * complete result remains in result_json; only the model-facing projection
     * is externalized/bounded and persisted. The transaction also makes an
     * artifact insert atomic with each context update.
     */
    materializeToolContextForTask(taskId: string): ToolCallRecord[] {
      db.transaction(() => {
        const rows = db.prepare(`SELECT id, task_id, tool_name, result_json, context_result_json, status, completed_at, created_at
          FROM message_tool_calls
          WHERE task_id=? AND status IN ('completed','failed','cancelled')
            AND result_json IS NOT NULL AND context_result_json IS NULL`).all(taskId) as Array<{
              id: string;
              task_id: string;
              tool_name: string;
              result_json: string;
              context_result_json: string | null;
              status: string;
              completed_at: string | null;
              created_at: string;
            }>;
        for (const row of rows) {
          const contextResultJson = deriveContextResult(db, {
            taskId: row.task_id,
            toolName: row.tool_name,
            resultJson: row.result_json,
            now: row.completed_at ?? row.created_at,
          });
          db.prepare("UPDATE message_tool_calls SET context_result_json=? WHERE id=? AND context_result_json IS NULL")
            .run(contextResultJson, row.id);
        }
      })();
      return db
        .prepare("SELECT * FROM message_tool_calls WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId)
        .map(mapToolCall);
    },

    getToolCall(id: string): ToolCallRecord | undefined {
      const row = db.prepare("SELECT * FROM message_tool_calls WHERE id = ?").get(id);
      return row ? mapToolCall(row) : undefined;
    },

    listToolCallsForMessage(messageId: string): ToolCallRecord[] {
      return db
        .prepare("SELECT * FROM message_tool_calls WHERE message_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(messageId)
        .map(mapToolCall);
    },

    listToolCallsForTask(taskId: string): ToolCallRecord[] {
      return db
        .prepare("SELECT * FROM message_tool_calls WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId)
        .map(mapToolCall);
    }
  };
}
