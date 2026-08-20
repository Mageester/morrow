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

/**
 * The actor is resolved by the orchestrator from a durable task/agent row.
 * It is intentionally not part of any client memory contract: ownership is
 * derived here, never accepted as an ownerAgentId/ownerTeamId payload.
 */
export type MemoryActor =
  | { kind: "user" }
  | { kind: "default" }
  | { kind: "agent"; agentId: string; teamId?: string | null }
  /** A team actor is only valid when the trusted execution identity also
   * supplies the active member agent. */
  | { kind: "team"; teamId: string; agentId: string };

export class MemoryOwnershipError extends Error {
  readonly code = "MEMORY_OWNERSHIP_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "MemoryOwnershipError";
  }
}

function isPrivateScope(scope: MemoryScope): scope is "agent" | "team" {
  return scope === "agent" || scope === "team";
}

function actorOwnsEntry(entry: Pick<MemoryEntry, "scope" | "ownerAgentId" | "ownerTeamId">, actor: MemoryActor): boolean {
  if (actor.kind === "user") return true;
  if (entry.scope === "agent") return actor.kind === "agent" && actor.agentId === entry.ownerAgentId;
  if (entry.scope === "team") {
    const teamId = actor.kind === "team" ? actor.teamId : actor.kind === "agent" ? actor.teamId ?? null : null;
    return teamId !== null && teamId === entry.ownerTeamId;
  }
  // All non-private scopes are deliberately unowned. A default teammate may
  // use project/global memory, subject to its separate scope policy.
  return entry.ownerAgentId === null && entry.ownerTeamId === null;
}

function ownerForCreate(scope: MemoryScope, actor?: MemoryActor): { ownerAgentId: string | null; ownerTeamId: string | null } {
  if (scope === "agent") {
    if (actor?.kind !== "agent" || !actor.agentId) throw new MemoryOwnershipError("Agent-scoped memory requires the executing agent owner");
    return { ownerAgentId: actor.agentId, ownerTeamId: null };
  }
  if (scope === "team") {
    const teamId = actor?.kind === "team" ? actor.teamId : actor?.kind === "agent" ? actor.teamId ?? null : null;
    if (!teamId) throw new MemoryOwnershipError("Team-scoped memory requires the executing team owner");
    return { ownerAgentId: null, ownerTeamId: teamId };
  }
  return { ownerAgentId: null, ownerTeamId: null };
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
  /** Trusted execution identity; never supplied as an owner field by clients. */
  actor?: MemoryActor;
  createdAt: string;
}

/**
 * Deterministic SQLite-backed memory. No vector store, no hidden capture: every
 * entry has an explicit source, optional task provenance, and a timestamp, is
 * scoped to a project (and optionally a conversation), and can be pinned,
 * disabled, or deleted by the user. Private agent/team rows additionally carry
 * an immutable owner derived from the durable execution actor. Reads are
 * strictly isolated by project and owner, so memory never leaks across
 * projects or teammates. Pinned entries are surfaced first.
 */
export function memoryRepository(db: Database.Database) {
  const map = (row: any): MemoryEntry =>
    MemoryEntrySchema.parse({
      version: 1,
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      scope: row.scope,
      ownerAgentId: row.owner_agent_id ?? null,
      ownerTeamId: row.owner_team_id ?? null,
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

  const accessible = (entry: MemoryEntry, actor?: MemoryActor): boolean => !actor || actorOwnsEntry(entry, actor);
  const assertWriteAccess = (entry: MemoryEntry, actor?: MemoryActor): void => {
    if (actor && !actorOwnsEntry(entry, actor)) {
      throw new MemoryOwnershipError("Memory ownership does not match the executing actor");
    }
  };
  const assertActorIdentity = (projectId: string, actor?: MemoryActor): void => {
    if (!actor || actor.kind === "user" || actor.kind === "default") return;
    if (actor.kind === "agent") {
      const row = db.prepare("SELECT project_id, team_id, enabled FROM agents WHERE id=?").get(actor.agentId) as { project_id: string; team_id: string | null; enabled: number } | undefined;
      if (!row || row.project_id !== projectId || Number(row.enabled) === 0 || (actor.teamId !== undefined && actor.teamId !== row.team_id)) {
        throw new MemoryOwnershipError("Executing agent is not the durable owner for this project");
      }
      if (row.team_id !== null) {
        const team = db.prepare("SELECT status FROM teams WHERE id=? AND project_id=?").get(row.team_id, projectId) as { status: string } | undefined;
        if (!team || team.status !== "active") throw new MemoryOwnershipError("Executing team is not active");
        if (!db.prepare("SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?").get(row.team_id, actor.agentId)) {
          throw new MemoryOwnershipError("Executing agent is not an active team member");
        }
      }
      return;
    }
    const row = db.prepare("SELECT project_id, status FROM teams WHERE id=?").get(actor.teamId) as { project_id: string; status: string } | undefined;
    if (!row || row.project_id !== projectId || row.status !== "active") throw new MemoryOwnershipError("Executing team is not active");
    if (!db.prepare("SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?").get(actor.teamId, actor.agentId)) {
      throw new MemoryOwnershipError("Executing agent is not an active team member");
    }
  };
  const assertActorExists = (actor?: MemoryActor): void => {
    if (!actor || actor.kind === "user" || actor.kind === "default") return;
    if (actor.kind === "agent") {
      const row = db.prepare("SELECT enabled FROM agents WHERE id=?").get(actor.agentId) as { enabled: number } | undefined;
      if (!row || Number(row.enabled) === 0) throw new MemoryOwnershipError("Executing agent is not available");
      return;
    }
    if (!db.prepare("SELECT id FROM teams WHERE id=?").get(actor.teamId)) throw new MemoryOwnershipError("Executing team is not available");
  };

  return {
    create(input: CreateMemoryInput): MemoryEntry {
      assertActorIdentity(input.projectId, input.actor);
      const owner = ownerForCreate(input.scope, input.actor);
      db.prepare(
        `INSERT INTO memory_entries (
           id, project_id, conversation_id, scope, owner_agent_id, owner_team_id, type, content, normalized_content, source,
           evidence_references_json, lifecycle, origin_task_id, pinned, enabled, last_verified_at,
           confidence, usage_count, success_contribution, failure_contribution, staleness,
           supersedes_id, conflicts_with_ids_json, sensitivity, expiration_policy, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.projectId,
        input.conversationId ?? null,
        input.scope,
        owner.ownerAgentId,
        owner.ownerTeamId,
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
      assertActorIdentity(input.projectId, input.actor);
      const existing = this.get(input.id);
      if (!existing) return this.create({ ...input, source: "cortex" });
      assertWriteAccess(existing, input.actor);
      const requestedOwner = ownerForCreate(input.scope, input.actor);
      if (existing.scope !== input.scope
        || existing.ownerAgentId !== requestedOwner.ownerAgentId
        || existing.ownerTeamId !== requestedOwner.ownerTeamId
        || (isPrivateScope(existing.scope) && existing.ownerAgentId === null && existing.ownerTeamId === null)) {
        throw new MemoryOwnershipError("Cortex cannot change or restore a private memory owner");
      }
      // Existing ownership is immutable. A repeated Cortex observation may
      // refresh content/provenance, but it cannot retarget another teammate.
      const evidence = [...existing.evidenceReferences];
      for (const ref of input.evidenceReferences ?? []) {
        if (!evidence.some((item) => item.kind === ref.kind && item.reference === ref.reference && item.note === ref.note)) evidence.push(ref);
      }
      db.prepare(
        `UPDATE memory_entries SET scope=?,type=?,content=?,normalized_content=?,source='cortex',
          evidence_references_json=?,lifecycle=?,last_verified_at=?,confidence=?,success_contribution=?,
          failure_contribution=?,staleness=?,supersedes_id=?,conflicts_with_ids_json=?,sensitivity=?,
          expiration_policy=?,expires_at=?,enabled=?,updated_at=? WHERE id=?`
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
        existing.enabled ? 1 : 0,
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
         WHERE project_id=? AND source='cortex' AND type IN (${placeholders}) AND lifecycle='active'
           AND owner_agent_id IS NULL AND owner_team_id IS NULL`
      ).run(updatedAt, projectId, ...types);
      return result.changes;
    },

    get(id: string, actor?: MemoryActor): MemoryEntry | undefined {
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id);
      const entry = row ? map(row) : undefined;
      if (entry) assertActorIdentity(entry.projectId, actor);
      return entry && accessible(entry, actor) ? entry : undefined;
    },

    listByProject(projectId: string, actor?: MemoryActor): MemoryEntry[] {
      assertActorIdentity(projectId, actor);
      return db
        .prepare("SELECT * FROM memory_entries WHERE project_id = ? ORDER BY pinned DESC, created_at ASC, id ASC")
        .all(projectId)
        .map(map)
        .filter((entry) => accessible(entry, actor));
    },

    /** Scope-filtered listing for the memory vault UI. A user gets every row
     * for inspection; an execution actor gets only its exact private owner plus
     * unowned shared scopes. Disabled rows remain user-visible for quarantine
     * review but never enter active recall. */
    listByScope(projectId: string, scope: MemoryScope, actor?: MemoryActor): MemoryEntry[] {
      assertActorIdentity(projectId, actor);
      return db
        .prepare("SELECT * FROM memory_entries WHERE project_id = ? AND scope = ? ORDER BY pinned DESC, created_at ASC, id ASC")
        .all(projectId, scope)
        .map(map)
        .filter((entry) => accessible(entry, actor));
    },

    /**
     * The ONE query that deliberately crosses project boundaries — and only
     * for `user_global` scope, which exists precisely to hold cross-project
     * "personal" facts (assistant profile candidates, user-wide preferences).
     * Every other scope stays strictly project-isolated via listByProject /
     * listByScope. Disabled and non-active entries are excluded so a
     * forgotten/archived personal fact never leaks back in.
     */
    listUserGlobal(actor?: MemoryActor): MemoryEntry[] {
      assertActorExists(actor);
      return db
        .prepare("SELECT * FROM memory_entries WHERE scope = 'user_global' AND owner_agent_id IS NULL AND owner_team_id IS NULL AND enabled = 1 ORDER BY pinned DESC, created_at ASC, id ASC")
        .all()
        .map(map)
        .filter((entry) => accessible(entry, actor));
    },

    /** Complete personal-memory vault listing for user-controlled inspection.
     * Unlike execution recall, this includes disabled and stale records so the
     * user can review, restore, edit, or permanently remove them. */
    listAllUserGlobal(actor?: MemoryActor): MemoryEntry[] {
      assertActorExists(actor);
      return db
        .prepare("SELECT * FROM memory_entries WHERE scope = 'user_global' AND owner_agent_id IS NULL AND owner_team_id IS NULL ORDER BY pinned DESC, created_at ASC, id ASC")
        .all()
        .map(map)
        .filter((entry) => accessible(entry, actor));
    },

    /**
     * Enabled entries applicable to a conversation: every project-wide tier plus
     * only this conversation's own conversation-scoped entries. Pinned first.
     */
    listActiveForConversation(projectId: string, conversationId: string, actor?: MemoryActor): MemoryEntry[] {
      assertActorIdentity(projectId, actor);
      return db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE project_id = ? AND enabled = 1
             AND (scope != 'conversation' OR conversation_id = ?)
           ORDER BY pinned DESC, created_at ASC, id ASC`
        )
        .all(projectId, conversationId)
        .map(map)
        .filter((entry) => accessible(entry, actor));
    },

    /** Ranked automatic recall. Only active, non-expired, non-invalidated memory
     * can affect execution; every returned record gets an auditable use count. */
    retrieveRelevant(
      projectId: string,
      conversationId: string,
      prompt: string,
      at: string,
      limit = 20,
      allowedScopes?: ReadonlySet<MemoryScope> | null,
      actor?: MemoryActor,
    ): MemoryEntry[] {
      const tokens = new Set(normalizeMemory(prompt).match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
      // Personal memory is intentionally global. Merge it with the current
      // project's records, then deduplicate rows that originated in this
      // project before ranking. No other scope crosses a project boundary.
      const seen = new Map<string, MemoryEntry>();
      for (const entry of this.listActiveForConversation(projectId, conversationId, actor)) seen.set(entry.id, entry);
      for (const entry of this.listUserGlobal(actor)) seen.set(entry.id, entry);
      const candidates = [...seen.values()]
        .filter((entry) => allowedScopes === undefined || allowedScopes === null || allowedScopes.has(entry.scope))
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

    setEnabled(id: string, enabled: boolean, updatedAt: string, actor?: MemoryActor): MemoryEntry | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;
      assertActorIdentity(existing.projectId, actor);
      assertWriteAccess(existing, actor);
      if (enabled && isPrivateScope(existing.scope) && existing.ownerAgentId === null && existing.ownerTeamId === null) {
        throw new MemoryOwnershipError("An orphaned private memory cannot be restored without a verified owner");
      }
      db.prepare("UPDATE memory_entries SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    /** User-controlled recovery for an orphaned private row. The replacement
     * owner must be a currently active teammate in the same project; callers
     * cannot move memory across project boundaries or assign raw ids. */
    reassignOwner(id: string, owner: Extract<MemoryActor, { kind: "agent" }>, updatedAt: string, actor: MemoryActor = { kind: "user" }): MemoryEntry | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;
      if (!isPrivateScope(existing.scope) || existing.projectId === "") throw new MemoryOwnershipError("Only private memory can be reassigned");
      if (actor.kind !== "user") throw new MemoryOwnershipError("Only the user can reassign a private memory owner");
      assertActorIdentity(existing.projectId, owner);
      const derived = ownerForCreate(existing.scope, owner);
      db.prepare("UPDATE memory_entries SET owner_agent_id=?, owner_team_id=?, enabled=1, updated_at=? WHERE id=?")
        .run(derived.ownerAgentId, derived.ownerTeamId, updatedAt, id);
      return this.get(id);
    },

    setPinned(id: string, pinned: boolean, updatedAt: string, actor?: MemoryActor): MemoryEntry | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;
      assertActorIdentity(existing.projectId, actor);
      assertWriteAccess(existing, actor);
      db.prepare("UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, updatedAt, id);
      return this.get(id);
    },

    updateContent(id: string, content: string, updatedAt: string, actor?: MemoryActor): MemoryEntry | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;
      assertActorIdentity(existing.projectId, actor);
      assertWriteAccess(existing, actor);
      db.prepare(
        `UPDATE memory_entries
         SET content = ?, normalized_content = ?, source = 'user', confidence = 1,
             lifecycle = 'active', staleness = 'current', last_verified_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(content, normalizeMemory(content), updatedAt, updatedAt, id);
      return this.get(id);
    },

    delete(id: string, actor?: MemoryActor): boolean {
      const existing = this.get(id);
      if (!existing) return false;
      assertActorIdentity(existing.projectId, actor);
      assertWriteAccess(existing, actor);
      const res = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
      return res.changes > 0;
    },

    /** Local, explicit, versioned export. `secret`-sensitivity content is
     * redacted — this is a file the user controls, but a secret should never
     * sit in a plaintext export any more than in a log. */
    exportEntries(projectId: string): { version: 1; exportedAt: string; entries: MemoryEntry[] } {
      const entries = this.listByProject(projectId).map((entry) =>
        entry.sensitivity === "secret" ? { ...entry, content: "[redacted]", normalizedContent: "[redacted]" } : entry,
      );
      return { version: 1, exportedAt: new Date().toISOString(), entries };
    },

    /**
     * Import never silently widens scope or permissions:
     * - every entry is re-scoped to the IMPORTING project — any projectId in
     *   the payload is ignored, so import can never resurrect a cross-project
     *   reach the importing project didn't already have;
     * - `agent`/`team` scoped entries are skipped outright — importing them
     *   would imply an agent/team identity this project may not have;
     * - source is always forced to "user" — import can never fake automatic
     *   ("cortex") learning provenance;
     * - lifecycle/pinned/confidence are never taken from the payload — every
     *   imported entry starts as an ordinary active, unpinned, default-
     *   confidence record the user can review like any other.
     */
    importEntries(projectId: string, entries: MemoryEntry[]): MemoryEntry[] {
      return db.transaction(() => {
        // Parse the complete batch before the first INSERT. This is defense in
        // depth for callers that use the repository directly, and guarantees a
        // malformed later row cannot leave an earlier row behind.
        const validated = entries.map((entry) => MemoryEntrySchema.parse(entry));
        const imported: MemoryEntry[] = [];
        for (const entry of validated) {
          if (entry.scope === "agent" || entry.scope === "team") continue;
          imported.push(this.create({
            id: crypto.randomUUID(),
            projectId,
            scope: entry.scope,
            type: entry.type,
            content: entry.content,
            source: "user",
            sensitivity: entry.sensitivity,
            createdAt: new Date().toISOString(),
          }));
        }
        return imported;
      })();
    },
  };
}
