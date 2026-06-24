import type Database from "better-sqlite3";
import { MemoryEntrySchema, type MemoryEntry, type MemoryScope } from "@morrow/contracts";

/**
 * Deterministic SQLite-backed memory. No vector store, no hidden capture: every
 * entry has an explicit source, optional task provenance, and a timestamp, is
 * scoped to a project (and optionally a conversation), and can be pinned,
 * disabled, or deleted by the user. Reads are strictly isolated by project id so
 * memory never leaks across projects. Pinned entries are surfaced first.
 */
export function memoryRepository(db: Database.Database) {
  const map = (row: any): MemoryEntry =>
    MemoryEntrySchema.parse({
      version: 1,
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      scope: row.scope,
      content: row.content,
      source: row.source,
      originTaskId: row.origin_task_id ?? null,
      pinned: Number(row.pinned) !== 0,
      enabled: Number(row.enabled) !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

  return {
    create(input: {
      id: string;
      projectId: string;
      conversationId?: string | null;
      scope: MemoryScope;
      content: string;
      source: "user" | "summary";
      originTaskId?: string | null;
      pinned?: boolean;
      createdAt: string;
    }): MemoryEntry {
      db.prepare(
        `INSERT INTO memory_entries (id, project_id, conversation_id, scope, content, source, origin_task_id, pinned, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        input.id,
        input.projectId,
        input.conversationId ?? null,
        input.scope,
        input.content,
        input.source,
        input.originTaskId ?? null,
        input.pinned ? 1 : 0,
        input.createdAt,
        input.createdAt
      );
      return this.get(input.id)!;
    },

    get(id: string): MemoryEntry | undefined {
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id);
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string): MemoryEntry[] {
      return db
        .prepare("SELECT * FROM memory_entries WHERE project_id = ? ORDER BY pinned DESC, created_at ASC, id ASC")
        .all(projectId)
        .map(map);
    },

    /**
     * Enabled entries applicable to a conversation: every project-wide tier plus
     * only this conversation's own conversation-scoped entries. Pinned first.
     */
    listActiveForConversation(projectId: string, conversationId: string): MemoryEntry[] {
      return db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE project_id = ? AND enabled = 1
             AND (scope != 'conversation' OR conversation_id = ?)
           ORDER BY pinned DESC, created_at ASC, id ASC`
        )
        .all(projectId, conversationId)
        .map(map);
    },

    setEnabled(id: string, enabled: boolean, updatedAt: string): MemoryEntry | undefined {
      db.prepare("UPDATE memory_entries SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    setPinned(id: string, pinned: boolean, updatedAt: string): MemoryEntry | undefined {
      db.prepare("UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    delete(id: string): boolean {
      const res = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
      return res.changes > 0;
    },
  };
}
