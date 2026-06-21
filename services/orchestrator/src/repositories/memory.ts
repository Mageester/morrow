import type Database from "better-sqlite3";
import { MemoryEntrySchema, type MemoryEntry, type MemoryScope } from "@morrow/contracts";

/**
 * Deterministic SQLite-backed memory. No vector store, no hidden capture: every
 * entry has an explicit source and timestamp, is scoped to a project (and
 * optionally a conversation), and can be disabled or deleted by the user. Reads
 * are strictly isolated by project id so memory never leaks across projects.
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
      createdAt: string;
    }): MemoryEntry {
      db.prepare(
        `INSERT INTO memory_entries (id, project_id, conversation_id, scope, content, source, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        input.id,
        input.projectId,
        input.conversationId ?? null,
        input.scope,
        input.content,
        input.source,
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
        .prepare("SELECT * FROM memory_entries WHERE project_id = ? ORDER BY created_at ASC, id ASC")
        .all(projectId)
        .map(map);
    },

    /** Enabled entries applicable to a conversation: project/user scope + this conversation's scope. */
    listActiveForConversation(projectId: string, conversationId: string): MemoryEntry[] {
      return db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE project_id = ? AND enabled = 1
             AND (scope IN ('project','user') OR (scope = 'conversation' AND conversation_id = ?))
           ORDER BY created_at ASC, id ASC`
        )
        .all(projectId, conversationId)
        .map(map);
    },

    setEnabled(id: string, enabled: boolean, updatedAt: string): MemoryEntry | undefined {
      db.prepare("UPDATE memory_entries SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    delete(id: string): boolean {
      const res = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
      return res.changes > 0;
    },
  };
}
