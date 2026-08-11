import type Database from "better-sqlite3";
import {
  ApproveMemoryCandidateSchema,
  MemoryCandidatePreviewSchema,
  type ApproveMemoryCandidateInput,
  type MemoryCandidate,
} from "@morrow/contracts";
import { auditLogRepository } from "../repositories/audit-log.js";
import { memoryCandidatesRepository } from "../repositories/memory-candidates.js";
import { memoryRepository, type MemoryRetrievalPolicy } from "../repositories/memory.js";

type CandidatesRepository = ReturnType<typeof memoryCandidatesRepository>;
type MemoryRepository = ReturnType<typeof memoryRepository>;

function memoryEvidence(candidate: MemoryCandidate) {
  return candidate.evidenceReferences.map((reference) => ({
    kind: reference.kind === "file" ? "file" as const : reference.kind === "command" ? "command" as const : reference.kind === "task" ? "mission" as const : "user" as const,
    reference: reference.id,
    ...(reference.label ? { note: reference.label } : {}),
  }));
}

function auditDetail(candidate: MemoryCandidate, extra: Record<string, unknown> = {}) {
  return {
    candidateId: candidate.id,
    scope: candidate.proposedScope,
    type: candidate.proposedType,
    sensitivity: candidate.sensitivity,
    evidenceIds: candidate.evidenceReferences.map((reference) => reference.id),
    ...extra,
  };
}

export type MemoryAdmissionOptions = {
  db: Database.Database;
  candidates?: CandidatesRepository;
  memory?: MemoryRepository;
};

export function createMemoryAdmission(options: MemoryAdmissionOptions) {
  const candidates = options.candidates ?? memoryCandidatesRepository(options.db);
  const memory = options.memory ?? memoryRepository(options.db);
  const auditLog = auditLogRepository(options.db);

  const now = () => new Date().toISOString();
  const getCandidate = (id: string, projectId?: string) => projectId ? candidates.getForProject(id, projectId) : candidates.get(id);
  const writeAudit = (candidate: MemoryCandidate, kind: string, detail: Record<string, unknown> = {}) => auditLog.append({
    projectId: candidate.projectId,
    taskId: candidate.originatingTaskId,
    kind,
    detail: auditDetail(candidate, detail),
    createdAt: now(),
  });

  return {
    propose(input: Parameters<CandidatesRepository["create"]>[0]): MemoryCandidate {
      if (input.sensitivity === "secret") throw new Error("Secret-like memory candidates are not admissible");
      return candidates.create(input);
    },

    approve(id: string, projectId: string, input: ApproveMemoryCandidateInput) {
      const value = ApproveMemoryCandidateSchema.parse(input);
      const candidate = candidates.getForProject(id, projectId);
      if (!candidate) throw new Error("Memory candidate not found");
      if (candidate.lifecycle !== "proposed") throw new Error(`Memory candidate is already ${candidate.lifecycle}`);
      if (candidate.sensitivity === "secret") throw new Error("Secret-like memory candidates cannot be approved");
      if (value.scope === "user_global" && !["user_preference", "communication_preference"].includes(candidate.proposedType)) {
        throw new Error("Only approved personal facts may use user_global scope");
      }
      const timestamp = now();
      const expiresAt = value.expiresAt === undefined ? candidate.expiresAt : value.expiresAt;
      const content = value.content ?? candidate.content;
      const oldCandidate = candidate.supersedesCandidateId ? candidates.get(candidate.supersedesCandidateId) : undefined;
      const oldMemory = oldCandidate?.approvedMemoryId ? memory.get(oldCandidate.approvedMemoryId) : undefined;
      if (oldMemory) memory.setLifecycle(oldMemory.id, "superseded", timestamp, false);
      const originTaskId = candidate.originatingTaskId && options.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(candidate.originatingTaskId)
        ? candidate.originatingTaskId
        : null;
      const entry = memory.create({
        id: crypto.randomUUID(),
        projectId,
        conversationId: candidate.conversationId,
        scope: value.scope,
        type: candidate.proposedType,
        content,
        normalizedContent: content.trim().toLowerCase().replace(/\s+/g, " "),
        source: "user",
        evidenceReferences: memoryEvidence(candidate),
        lifecycle: "active",
        originTaskId,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        expirationPolicy: value.expirationPolicy ?? candidate.expirationPolicy,
        expiresAt,
        supersedesId: oldMemory?.id ?? null,
        conflictsWithIds: oldMemory ? [oldMemory.id] : [],
        createdAt: timestamp,
      });
      const approved = candidates.linkApprovedMemory(id, entry.id, timestamp);
      writeAudit(approved, "memory.candidate.approved", { selectedScope: value.scope, memoryId: entry.id });
      if (oldMemory) writeAudit(approved, "memory.candidate.superseded", { supersededMemoryId: oldMemory.id });
      return { candidate: approved, memory: entry };
    },

    edit(id: string, projectId: string, input: Parameters<CandidatesRepository["edit"]>[2]) {
      const updated = candidates.edit(id, projectId, input, now());
      writeAudit(updated, "memory.candidate.edited");
      return updated;
    },

    reject(id: string, projectId: string, reason = "Rejected by user") {
      const candidate = candidates.getForProject(id, projectId);
      if (!candidate) throw new Error("Memory candidate not found");
      if (candidate.lifecycle !== "proposed") throw new Error(`Memory candidate is already ${candidate.lifecycle}`);
      const rejected = candidates.setLifecycle(id, "rejected", now(), reason)!;
      writeAudit(rejected, "memory.candidate.rejected", { reason });
      return rejected;
    },

    forget(id: string, projectId: string) {
      const candidate = candidates.getForProject(id, projectId);
      if (!candidate) throw new Error("Memory candidate not found");
      const timestamp = now();
      if (candidate.approvedMemoryId) memory.forget(candidate.approvedMemoryId, timestamp);
      const forgotten = candidates.setLifecycle(id, "rejected", timestamp, "Forgotten by user")!;
      writeAudit(forgotten, "memory.candidate.forgotten");
      return { candidate: forgotten, forgotten: true };
    },

    expire(at = now()) {
      const expired = candidates.expireDue(at);
      for (const candidate of expired) {
        if (candidate.approvedMemoryId) memory.forget(candidate.approvedMemoryId, at);
        writeAudit(candidate, "memory.candidate.expired");
      }
      return expired;
    },

    retrieve(projectId: string, conversationId: string, prompt: string, at = now(), limit = 20, policy: MemoryRetrievalPolicy = {}) {
      this.expire(at);
      return memory.retrieveRelevant(projectId, conversationId, prompt, at, limit, policy);
    },

    disclosure(id: string): ReturnType<typeof MemoryCandidatePreviewSchema.parse> {
      const candidate = candidates.get(id);
      if (!candidate) throw new Error("Memory candidate not found");
      return MemoryCandidatePreviewSchema.parse({
        id: candidate.id,
        lifecycle: candidate.lifecycle,
        proposedType: candidate.proposedType,
        proposedScope: candidate.proposedScope,
        sensitivity: candidate.sensitivity,
        confidence: candidate.confidence,
        evidenceIds: candidate.evidenceReferences.map((reference) => reference.id),
        sourceLabel: candidate.evidenceReferences[0]?.label ?? candidate.evidenceReferences[0]?.kind ?? "Task evidence",
        expirationPolicy: candidate.expirationPolicy,
        expiresAt: candidate.expiresAt,
      });
    },

    audit: () => auditLog.list(),
    candidates,
    memory,
  };
}

export const memoryAdmission = createMemoryAdmission;
