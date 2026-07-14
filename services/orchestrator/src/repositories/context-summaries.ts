import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

export interface ContextSummaryRecord {
  id: string;
  projectId: string;
  conversationId: string;
  taskId: string | null;
  method: "deterministic" | "fallback" | "model-assisted";
  content: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceMessageCount: number;
  sourceHash: string;
  createdAt: string;
}

function map(row: any): ContextSummaryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    method: row.method,
    content: row.content,
    sourceStartIndex: Number(row.source_start_index),
    sourceEndIndex: Number(row.source_end_index),
    sourceMessageCount: Number(row.source_message_count),
    sourceHash: row.source_hash,
    createdAt: row.created_at,
  };
}

export function contextSourceHash(input: { conversationId: string; taskId?: string | null; sourceStartIndex: number; sourceEndIndex: number; content: string }): string {
  return createHash("sha256")
    .update(input.conversationId)
    .update("\0")
    .update(input.taskId ?? "conversation")
    .update("\0")
    .update(String(input.sourceStartIndex))
    .update("\0")
    .update(String(input.sourceEndIndex))
    .update("\0")
    .update(input.content)
    .digest("hex");
}

export function contextSummariesRepository(db: Database.Database) {
  return {
    record(input: Omit<ContextSummaryRecord, "sourceHash"> & { sourceHash?: string }): ContextSummaryRecord {
      const sourceHash =
        input.sourceHash ??
        contextSourceHash({
          conversationId: input.conversationId,
          taskId: input.taskId,
          sourceStartIndex: input.sourceStartIndex,
          sourceEndIndex: input.sourceEndIndex,
          content: input.content,
        });
      db.prepare(
        `INSERT INTO context_summaries
         (id,project_id,conversation_id,task_id,method,content,source_start_index,source_end_index,source_message_count,source_hash,created_at)
         VALUES (@id,@projectId,@conversationId,@taskId,@method,@content,@sourceStartIndex,@sourceEndIndex,@sourceMessageCount,@sourceHash,@createdAt)
         ON CONFLICT(conversation_id, source_hash) DO UPDATE SET task_id=COALESCE(excluded.task_id, task_id)`
      ).run({ ...input, sourceHash, taskId: input.taskId ?? null });
      return this.getByHash(input.conversationId, sourceHash)!;
    },

    getByHash(conversationId: string, sourceHash: string): ContextSummaryRecord | undefined {
      const row = db.prepare("SELECT * FROM context_summaries WHERE conversation_id=? AND source_hash=?").get(conversationId, sourceHash);
      return row ? map(row) : undefined;
    },

    latestForConversation(conversationId: string): ContextSummaryRecord | undefined {
      const row = db.prepare("SELECT * FROM context_summaries WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId);
      return row ? map(row) : undefined;
    },

    latestManualForConversation(conversationId: string): ContextSummaryRecord | undefined {
      const row = db.prepare("SELECT * FROM context_summaries WHERE conversation_id=? AND task_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId);
      return row ? map(row) : undefined;
    },

    latestForTask(taskId: string): ContextSummaryRecord | undefined {
      const row = db.prepare("SELECT * FROM context_summaries WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(taskId);
      return row ? map(row) : undefined;
    },
  };
}
