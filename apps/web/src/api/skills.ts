import {
  LearnedSkillSchema,
  SkillCatalogEntrySchema,
  SkillCatalogStatusSchema,
  SkillUsageSchema,
  type SkillCatalogEntry,
  type SkillCatalogStatus,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

/**
 * The service's skill catalog is the only authority on what exists and what is
 * loadable. The page renders that answer rather than a local approximation of
 * it, so a skill that reads as enabled here is one the agent can actually load.
 */
export type InstalledSkill = SkillCatalogEntry;

function skillsPath(base: string, projectId?: string): string {
  return projectId ? `${base}?projectId=${encodeURIComponent(projectId)}` : base;
}

export const skillQueries = {
  installed(projectId?: string) {
    return queryOptions({
      queryKey: ["skills", "installed", projectId ?? null] as const,
      queryFn: () => api.get(skillsPath("/api/skills", projectId), SkillCatalogEntrySchema.array()),
    });
  },
  /**
   * Root diagnostics, queried alongside the list. An empty list means one of
   * two very different things — nothing installed, or a root Morrow could not
   * read — and only this tells them apart.
   */
  status(projectId?: string) {
    return queryOptions({
      queryKey: ["skills", "status", projectId ?? null] as const,
      queryFn: () => api.get(skillsPath("/api/skills/status", projectId), SkillCatalogStatusSchema),
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

export type { SkillCatalogEntry, SkillCatalogStatus };

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

/**
 * An install returns the catalog entry it produced — disabled, with the key
 * needed to enable it. The service never reports a directory, so the browser
 * never learns where on disk anything lives.
 */
const InstalledResultSchema = SkillCatalogEntrySchema;

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
  /**
   * Activation is a server decision: the catalog refuses to enable an entry it
   * cannot load, and the entry it returns is the state that actually took
   * effect. Nothing here optimistically flips a switch.
   */
  setEnabled(key: string, enabled: boolean, projectId?: string) {
    return api.patch(
      skillsPath(`/api/skills/${encodeURIComponent(key)}`, projectId),
      { enabled },
      SkillCatalogEntrySchema,
    );
  },
  remove(key: string) {
    return api.delete(`/api/skills/${encodeURIComponent(key)}`, z.unknown());
  },
};
