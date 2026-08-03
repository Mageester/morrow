import type Database from "better-sqlite3";
import { ConversationSchema, ConversationMessageSchema, type Conversation, type ConversationMessage } from "@morrow/contracts";
import { redactSecrets } from "../provider/credentials.js";

export interface ToolCallRecord {
  id: string;
  messageId: string;
  taskId: string;
  toolName: string;
  argsJson: string;
  resultJson?: string | null;
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
      argsJson: row.args_json,
      resultJson: row.result_json,
      status: row.status,
      errorType: row.error_type,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  };

  return {
    createConversation(input: Omit<Conversation, "version" | "archived"> & { archived?: boolean }): Conversation {
      db.prepare(
        "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(input.id, input.projectId, input.title, input.createdAt, input.updatedAt);
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

    renameConversation(id: string, title: string, updatedAt: string): Conversation | undefined {
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, id);
      return this.getConversation(id);
    },

    setArchived(id: string, archived: boolean, updatedAt: string): Conversation | undefined {
      db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, updatedAt, id);
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
        .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC")
        .all(conversationId)
        .map(mapMessage);
    },

    updateMessageContentAndState(id: string, content: string, streamingState: string, updatedAt: string): ConversationMessage {
      const current = db.prepare("SELECT role FROM conversation_messages WHERE id = ?").get(id) as { role: string } | undefined;
      const safeContent = current?.role === "assistant" ? redactSecrets(content) : content;
      db.transaction(() => {
        db.prepare(
          "UPDATE conversation_messages SET content = ?, streaming_state = ?, updated_at = ? WHERE id = ?"
        ).run(safeContent, streamingState, updatedAt, id);
        
        const msg = this.getMessage(id);
        if (msg) {
          db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, msg.conversationId);
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
      const existingTaskId = db
        .prepare("SELECT task_id FROM message_tool_calls WHERE id = ?")
        .get(input.id) as { task_id: string } | undefined;
      if (existingTaskId && existingTaskId.task_id !== input.taskId) {
        throw new Error(
          `Tool-call id collision: "${input.id}" is already recorded under task ${existingTaskId.task_id} and cannot be rewritten by task ${input.taskId}. Tool-call ids must be unique per task; the provider adapter that minted this id is reusing it across streams.`
        );
      }
      db.prepare(
        `INSERT INTO message_tool_calls
         (id, message_id, task_id, tool_name, args_json, result_json, status, error_type, error_message, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           result_json = excluded.result_json,
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
        input.argsJson,
        input.resultJson || null,
        input.status,
        input.errorType || null,
        input.errorMessage || null,
        input.createdAt,
        input.startedAt || null,
        input.completedAt || null
      );
      return this.getToolCall(input.id)!;
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
