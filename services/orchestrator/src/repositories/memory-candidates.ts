import type Database from "better-sqlite3";
import {
  CreateMemoryCandidateSchema,
  EditMemoryCandidateSchema,
  MemoryCandidateSchema,
  type CreateMemoryCandidateInput,
  type EditMemoryCandidateInput,
  type MemoryCandidate,
} from "@morrow/contracts";

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ");
}

export function memoryCandidatesRepository(db: Database.Database) {
  const map = (row: any): MemoryCandidate => MemoryCandidateSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id ?? null,
    originatingTaskId: row.originating_task_id ?? null,
    content: row.content,
    normalizedContent: row.normalized_content,
    proposedType: row.proposed_type,
    proposedScope: row.proposed_scope,
    sensitivity: row.sensitivity,
    confidence: Number(row.confidence),
    evidenceReferences: JSON.parse(row.evidence_references_json ?? "[]"),
    expirationPolicy: row.expiration_policy,
    expiresAt: row.expires_at ?? null,
    lifecycle: row.lifecycle,
    ...(row.supersedes_candidate_id ? { supersedesCandidateId: row.supersedes_candidate_id } : {}),
    ...(row.approved_memory_id ? { approvedMemoryId: row.approved_memory_id } : {}),
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const get = (id: string): MemoryCandidate | undefined => {
    const row = db.prepare("SELECT * FROM memory_candidates WHERE id=?").get(id);
    return row ? map(row) : undefined;
  };

  return {
    create(input: CreateMemoryCandidateInput): MemoryCandidate {
      const value = CreateMemoryCandidateSchema.parse(input);
      const normalizedContent = value.normalizedContent ?? normalize(value.content);
      db.prepare(`
        INSERT INTO memory_candidates(
          id,project_id,conversation_id,originating_task_id,content,normalized_content,
          proposed_type,proposed_scope,sensitivity,confidence,evidence_references_json,
          expiration_policy,expires_at,lifecycle,supersedes_candidate_id,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)
      `).run(
        value.id,
        value.projectId,
        value.conversationId ?? null,
        value.originatingTaskId ?? null,
        value.content,
        normalizedContent,
        value.proposedType,
        value.proposedScope,
        value.sensitivity,
        value.confidence,
        JSON.stringify(value.evidenceReferences ?? []),
        value.expirationPolicy ?? "never",
        value.expiresAt ?? null,
        "proposed",
        value.supersedesCandidateId ?? null,
        value.createdAt,
        value.createdAt,
      );
      return get(value.id)!;
    },

    get,

    getForProject(id: string, projectId: string): MemoryCandidate | undefined {
      const row = db.prepare("SELECT * FROM memory_candidates WHERE id=? AND project_id=?").get(id, projectId);
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string, lifecycle?: MemoryCandidate["lifecycle"]): MemoryCandidate[] {
      const rows = lifecycle
        ? db.prepare("SELECT * FROM memory_candidates WHERE project_id=? AND lifecycle=? ORDER BY created_at ASC,id ASC").all(projectId, lifecycle)
        : db.prepare("SELECT * FROM memory_candidates WHERE project_id=? ORDER BY created_at ASC,id ASC").all(projectId);
      return rows.map(map);
    },

    edit(id: string, projectId: string, input: EditMemoryCandidateInput, updatedAt: string): MemoryCandidate {
      const current = this.getForProject(id, projectId);
      if (!current) throw new Error("Memory candidate not found");
      if (current.lifecycle !== "proposed") throw new Error("Only proposed memory candidates can be edited");
      const value = EditMemoryCandidateSchema.parse(input);
      db.prepare(`
        UPDATE memory_candidates SET content=?,normalized_content=?,proposed_type=?,proposed_scope=?,
          expiration_policy=?,expires_at=?,updated_at=? WHERE id=? AND project_id=? AND lifecycle='proposed'
      `).run(
        value.content ?? current.content,
        value.content ? normalize(value.content) : current.normalizedContent,
        value.proposedType ?? current.proposedType,
        value.proposedScope ?? current.proposedScope,
        value.expirationPolicy ?? current.expirationPolicy,
        value.expiresAt === undefined ? current.expiresAt : value.expiresAt,
        updatedAt,
        id,
        projectId,
      );
      return this.get(id)!;
    },

    setLifecycle(id: string, lifecycle: MemoryCandidate["lifecycle"], updatedAt: string, detail?: string): MemoryCandidate | undefined {
      db.prepare("UPDATE memory_candidates SET lifecycle=?,rejection_reason=?,updated_at=? WHERE id=?")
        .run(lifecycle, detail ?? null, updatedAt, id);
      return get(id);
    },

    linkApprovedMemory(id: string, memoryId: string, updatedAt: string): MemoryCandidate {
      db.prepare("UPDATE memory_candidates SET lifecycle='approved',approved_memory_id=?,rejection_reason=NULL,updated_at=? WHERE id=?")
        .run(memoryId, updatedAt, id);
      return get(id)!;
    },

    expireDue(at: string): MemoryCandidate[] {
      const rows = db.prepare("SELECT * FROM memory_candidates WHERE lifecycle IN ('proposed','approved') AND expires_at IS NOT NULL AND expires_at<=?").all(at);
      if (rows.length > 0) db.prepare("UPDATE memory_candidates SET lifecycle='expired',updated_at=? WHERE lifecycle IN ('proposed','approved') AND expires_at IS NOT NULL AND expires_at<=?").run(at, at);
      return rows.map((row) => map({ ...(row as Record<string, unknown>), lifecycle: "expired", updated_at: at }));
    },
  };
}
