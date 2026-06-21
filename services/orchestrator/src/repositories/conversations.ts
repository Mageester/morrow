import type Database from "better-sqlite3";
import { ConversationSchema, ConversationMessageSchema, type Conversation, type ConversationMessage } from "@morrow/contracts";

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
      content: row.content,
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
      db.transaction(() => {
        db.prepare(
          `INSERT INTO conversation_messages 
           (id, conversation_id, role, content, task_id, streaming_state, provider, model, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.id,
          input.conversationId,
          input.role,
          input.content,
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
      db.transaction(() => {
        db.prepare(
          "UPDATE conversation_messages SET content = ?, streaming_state = ?, updated_at = ? WHERE id = ?"
        ).run(content, streamingState, updatedAt, id);
        
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
        .prepare("SELECT * FROM message_tool_calls WHERE message_id = ? ORDER BY created_at ASC")
        .all(messageId)
        .map(mapToolCall);
    },

    listToolCallsForTask(taskId: string): ToolCallRecord[] {
      return db
        .prepare("SELECT * FROM message_tool_calls WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId)
        .map(mapToolCall);
    }
  };
}
