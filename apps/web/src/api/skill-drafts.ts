import {
  ApproveSkillDraftSchema,
  SkillDraftSchema,
  type ApproveSkillDraftInput,
  type SkillDraft,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const RollbackResultSchema = z.object({
  draft: SkillDraftSchema,
  quarantinedAt: z.string().nullable(),
}).strict();

export const skillDraftQueries = {
  get(id: string) {
    return queryOptions({
      queryKey: ["skill-draft", id] as const,
      queryFn: () => api.get(`/api/skill-drafts/${encodeURIComponent(id)}`, SkillDraftSchema),
      enabled: Boolean(id),
    });
  },
  list(projectId: string) {
    return queryOptions({
      queryKey: ["skill-drafts", projectId] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/skill-drafts`, SkillDraftSchema.array()),
      enabled: Boolean(projectId),
    });
  },
};

export const skillDraftApi = {
  create(taskId: string) {
    return api.post(`/api/tasks/${encodeURIComponent(taskId)}/skill-draft`, { taskId }, SkillDraftSchema);
  },
  replay(id: string, fixtureId?: string) {
    return api.post(`/api/skill-drafts/${encodeURIComponent(id)}/replay`, fixtureId ? { fixtureId } : {}, SkillDraftSchema);
  },
  approve(id: string, input: Partial<ApproveSkillDraftInput> = {}) {
    return api.post(`/api/skill-drafts/${encodeURIComponent(id)}/approve`, ApproveSkillDraftSchema.parse(input), SkillDraftSchema);
  },
  rollback(id: string, reason?: string) {
    return api.post(`/api/skill-drafts/${encodeURIComponent(id)}/rollback`, reason ? { reason } : {}, RollbackResultSchema);
  },
};

export type SkillDraftApi = typeof skillDraftApi;
export type SkillDraftView = SkillDraft;
