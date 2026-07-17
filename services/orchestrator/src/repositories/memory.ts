import type Database from "better-sqlite3";
import {
  MemoryEntrySchema,
  type MemoryEntry,
  type MemoryEvidenceReference,
  type MemoryLifecycle,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryType,
} from "@morrow/contracts";

function normalizeMemory(content: string): string {
  return content.trim().toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ");
}

export interface CreateMemoryInput {
  id: string;
  projectId: string;
  conversationId?: string | null;
  scope: MemoryScope;
  type?: MemoryType;
  content: string;
  normalizedContent?: string;
  source: "user" | "summary" | "cortex";
  evidenceReferences?: MemoryEvidenceReference[];
  lifecycle?: MemoryLifecycle;
  originTaskId?: string | null;
  pinned?: boolean;
  lastVerifiedAt?: string | null;
  confidence?: number;
  usageCount?: number;
  successContribution?: number;
  failureContribution?: number;
  staleness?: MemoryEntry["staleness"];
  supersedesId?: string | null;
  conflictsWithIds?: string[];
  sensitivity?: MemorySensitivity;
  expirationPolicy?: string;
  expiresAt?: string | null;
  createdAt: string;
}

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
      type: row.type,
      content: row.content,
      normalizedContent: row.normalized_content || normalizeMemory(row.content),
      source: row.source,
      evidenceReferences: JSON.parse(row.evidence_references_json ?? "[]"),
      lifecycle: row.lifecycle,
      originTaskId: row.origin_task_id ?? null,
      pinned: Number(row.pinned) !== 0,
      enabled: Number(row.enabled) !== 0,
      lastVerifiedAt: row.last_verified_at ?? null,
      confidence: Number(row.confidence),
      usageCount: Number(row.usage_count),
      successContribution: Number(row.success_contribution),
      failureContribution: Number(row.failure_contribution),
      staleness: row.staleness,
      supersedesId: row.supersedes_id ?? null,
      conflictsWithIds: JSON.parse(row.conflicts_with_ids_json ?? "[]"),
      sensitivity: row.sensitivity,
      expirationPolicy: row.expiration_policy,
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

  return {
    create(input: CreateMemoryInput): MemoryEntry {
      db.prepare(
        `INSERT INTO memory_entries (
           id, project_id, conversation_id, scope, type, content, normalized_content, source,
           evidence_references_json, lifecycle, origin_task_id, pinned, enabled, last_verified_at,
           confidence, usage_count, success_contribution, failure_contribution, staleness,
           supersedes_id, conflicts_with_ids_json, sensitivity, expiration_policy, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.projectId,
        input.conversationId ?? null,
        input.scope,
        input.type ?? "project_architecture",
        input.content,
        input.normalizedContent ?? normalizeMemory(input.content),
        input.source,
        JSON.stringify(input.evidenceReferences ?? []),
        input.lifecycle ?? "active",
        input.originTaskId ?? null,
        input.pinned ? 1 : 0,
        input.lastVerifiedAt ?? null,
        input.confidence ?? (input.source === "user" ? 1 : 0.5),
        input.usageCount ?? 0,
        input.successContribution ?? 0,
        input.failureContribution ?? 0,
        input.staleness ?? "current",
        input.supersedesId ?? null,
        JSON.stringify(input.conflictsWithIds ?? []),
        input.sensitivity ?? "internal",
        input.expirationPolicy ?? "never",
        input.expiresAt ?? null,
        input.createdAt,
        input.createdAt
      );
      return this.get(input.id)!;
    },

    upsertCortex(input: Omit<CreateMemoryInput, "source">): MemoryEntry {
      const existing = this.get(input.id);
      if (!existing) return this.create({ ...input, source: "cortex" });
      const evidence = [...existing.evidenceReferences];
      for (const ref of input.evidenceReferences ?? []) {
        if (!evidence.some((item) => item.kind === ref.kind && item.reference === ref.reference && item.note === ref.note)) evidence.push(ref);
      }
      db.prepare(
        `UPDATE memory_entries SET scope=?,type=?,content=?,normalized_content=?,source='cortex',
          evidence_references_json=?,lifecycle=?,last_verified_at=?,confidence=?,success_contribution=?,
          failure_contribution=?,staleness=?,supersedes_id=?,conflicts_with_ids_json=?,sensitivity=?,
          expiration_policy=?,expires_at=?,enabled=1,updated_at=? WHERE id=?`
      ).run(
        input.scope,
        input.type ?? existing.type,
        input.content,
        input.normalizedContent ?? normalizeMemory(input.content),
        JSON.stringify(evidence),
        input.lifecycle ?? existing.lifecycle,
        input.lastVerifiedAt ?? existing.lastVerifiedAt,
        Math.max(existing.confidence, input.confidence ?? 0.5),
        Math.max(existing.successContribution, input.successContribution ?? 0),
        Math.max(existing.failureContribution, input.failureContribution ?? 0),
        input.staleness ?? existing.staleness,
        input.supersedesId ?? existing.supersedesId,
        JSON.stringify(input.conflictsWithIds ?? existing.conflictsWithIds),
        input.sensitivity ?? existing.sensitivity,
        input.expirationPolicy ?? existing.expirationPolicy,
        input.expiresAt ?? existing.expiresAt,
        input.lastVerifiedAt ?? input.createdAt,
        input.id,
      );
      return this.get(input.id)!;
    },

    markCortexStale(projectId: string, types: MemoryType[], updatedAt: string): number {
      if (types.length === 0) return 0;
      const placeholders = types.map(() => "?").join(",");
      const result = db.prepare(
        `UPDATE memory_entries SET lifecycle='stale',staleness='stale',updated_at=?
         WHERE project_id=? AND source='cortex' AND type IN (${placeholders}) AND lifecycle='active'`
      ).run(updatedAt, projectId, ...types);
      return result.changes;
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

    /** Ranked automatic recall. Only active, non-expired, non-invalidated memory
     * can affect execution; every returned record gets an auditable use count. */
    retrieveRelevant(projectId: string, conversationId: string, prompt: string, at: string, limit = 20): MemoryEntry[] {
      const tokens = new Set(normalizeMemory(prompt).match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
      const candidates = this.listActiveForConversation(projectId, conversationId)
        .filter((entry) => entry.lifecycle === "active")
        .filter((entry) => entry.staleness !== "stale" && entry.staleness !== "invalidated")
        .filter((entry) => !entry.expiresAt || entry.expiresAt > at)
        .map((entry) => {
          const haystack = new Set(entry.normalizedContent.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
          let score = entry.pinned ? 100 : 0;
          for (const token of tokens) if (haystack.has(token)) score += 1;
          score += entry.confidence;
          return { entry, score };
        })
        .filter(({ entry, score }) => entry.pinned || tokens.size === 0 || score > entry.confidence)
        .sort((a, b) => b.score - a.score || (b.entry.lastVerifiedAt ?? "").localeCompare(a.entry.lastVerifiedAt ?? ""))
        .slice(0, limit);
      if (candidates.length > 0) {
        const update = db.prepare("UPDATE memory_entries SET usage_count=usage_count+1, updated_at=? WHERE id=?");
        db.transaction(() => { for (const { entry } of candidates) update.run(at, entry.id); })();
      }
      return candidates.map(({ entry }) => this.get(entry.id)!);
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
