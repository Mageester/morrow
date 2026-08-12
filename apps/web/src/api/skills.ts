import { LearnedSkillSchema, SkillUsageSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export const InstalledSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  trustTier: z.string(),
  enabled: z.boolean(),
  validation: z.string(),
  tools: z.array(z.string()),
  permissions: z.array(z.string()),
  dependencies: z.array(z.string()),
  source: z.string(),
}).strict();

export const skillQueries = {
  installed() {
    return queryOptions({
      queryKey: ["skills", "installed"] as const,
      queryFn: () => api.get("/api/skills", InstalledSkillSchema.array()),
    });
  },
  learned(projectId: string) {
    return queryOptions({
      queryKey: ["skills", "learned", projectId] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/skills/learned`, LearnedSkillSchema.array()),
      enabled: Boolean(projectId),
    });
  },
  usage(projectId: string) {
    return queryOptions({
      queryKey: ["skills", "usage", projectId] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/skills/usage`, SkillUsageSchema.array()),
      enabled: Boolean(projectId),
    });
  },
};

export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;
