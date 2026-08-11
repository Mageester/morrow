import {
  ApproveMemoryCandidateSchema,
  MemoryCandidatePreviewSchema,
  MemoryCandidateSchema,
  MemoryEntrySchema,
  type ApproveMemoryCandidateInput,
  type EditMemoryCandidateInput,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const ApprovalResultSchema = z.object({ candidate: MemoryCandidateSchema, memory: MemoryEntrySchema }).strict();

export const memoryCandidateQueries = {
  list(projectId: string) {
    return queryOptions({
      queryKey: ["memory-candidates", projectId] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/memory-candidates`, MemoryCandidateSchema.array()),
      enabled: Boolean(projectId),
    });
  },
};

export const memoryCandidateApi = {
  create(projectId: string, input: Omit<ApproveMemoryCandidateInput, "scope"> & { content: string; proposedType: string; proposedScope: string; confidence?: number; evidenceReferences?: unknown[] }) {
    return api.post(`/api/projects/${encodeURIComponent(projectId)}/memory-candidates`, input, MemoryCandidateSchema);
  },
  approve(id: string, input: ApproveMemoryCandidateInput) {
    return api.post(`/api/memory-candidates/${encodeURIComponent(id)}/approve`, input, ApprovalResultSchema);
  },
  edit(id: string, projectId: string, input: EditMemoryCandidateInput) {
    return api.patch(`/api/memory-candidates/${encodeURIComponent(id)}`, { projectId, ...input }, MemoryCandidateSchema);
  },
  reject(id: string, projectId: string, reason?: string) {
    return api.post(`/api/memory-candidates/${encodeURIComponent(id)}/reject`, { projectId, ...(reason ? { reason } : {}) }, MemoryCandidateSchema);
  },
  forget(id: string, projectId: string) {
    return api.post(`/api/memory-candidates/${encodeURIComponent(id)}/forget`, { projectId }, z.object({ candidate: MemoryCandidateSchema, forgotten: z.literal(true) }).strict());
  },
  preview(id: string) {
    return api.get(`/api/memory-candidates/${encodeURIComponent(id)}/preview`, MemoryCandidatePreviewSchema);
  },
};

export { ApproveMemoryCandidateSchema };
