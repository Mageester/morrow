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

/* ── Installing ──────────────────────────────────────────────────────────── */

export const SkillPermissionsSchema = z.object({
  tools: z.array(z.string()),
  filesystemScopes: z.array(z.string()),
  networkDomains: z.array(z.string()),
  requiredSecrets: z.array(z.string()),
}).strict();

export const SkillInstallPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  publisher: z.string(),
  riskClass: z.string(),
  /** Where this came from, as it will be recorded alongside the skill. */
  source: z.string(),
  /** SHA-256 of SKILL.md — the identity of the instructions themselves. */
  checksum: z.string(),
  permissions: SkillPermissionsSchema,
  files: z.array(z.object({ path: z.string(), bytes: z.number() }).strict()),
  /**
   * Metadata Morrow wrote because the bundle shipped none. Shown to the user
   * so an empty permission set reads as our least-privilege default rather
   * than the author's considered answer.
   */
  generatedMetadata: z.array(z.string()),
  replaces: z.string().nullable(),
  warnings: z.array(z.string()),
}).strict();

export const SkillInstallPreviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), plan: SkillInstallPlanSchema, handle: z.string() }).strict(),
  z.object({
    kind: z.literal("choices"),
    source: z.string(),
    candidates: z.array(z.object({ subdir: z.string(), id: z.string(), name: z.string(), description: z.string() }).strict()),
  }).strict(),
]);

const InstalledResultSchema = z.object({ id: z.string(), directory: z.string(), enabled: z.boolean() }).strict();

export type SkillInstallPlan = z.infer<typeof SkillInstallPlanSchema>;
export type SkillInstallPreview = z.infer<typeof SkillInstallPreviewSchema>;

export const skillApi = {
  /**
   * Look, without installing. The service fetches, normalizes, verifies and
   * stages the bundle, then hands back what it found; nothing reaches the
   * skill root until `install` is called with the handle. That split is what
   * lets the panel show a person what they are agreeing to.
   */
  preview(source: string, options: { subdir?: string | null; overwrite?: boolean } = {}) {
    return api.post(
      "/api/skills/install/preview",
      { source, subdir: options.subdir ?? null, overwrite: options.overwrite ?? false },
      SkillInstallPreviewSchema,
    );
  },
  install(handle: string) {
    return api.post("/api/skills/install", { handle }, InstalledResultSchema);
  },
  discard(handle: string) {
    return api.post("/api/skills/install/discard", { handle }, z.unknown());
  },
  remove(id: string) {
    return api.delete(`/api/skills/${encodeURIComponent(id)}`, z.unknown());
  },
};
