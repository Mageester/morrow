import { MemoryEntrySchema, MemoryScopeSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export const memoryQueries = {
  list(projectId: string, scope?: string) {
    const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    return queryOptions({
      queryKey: ["memory", "list", projectId, scope ?? "all"] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/memory${query}`, MemoryEntrySchema.array()),
      enabled: Boolean(projectId),
    });
  },
};

export const MEMORY_SCOPE_LABELS: Record<string, string> = {
  project: "Project",
  user_global: "Personal (all projects)",
  agent: "Agent",
  team: "Team",
  conversation: "Conversation",
  temporary_context: "Task (temporary)",
  episodic: "Episodic",
  procedural: "Procedural",
  knowledge: "Knowledge",
  machine_environment: "Machine environment",
  workspace: "Workspace",
  repository: "Repository",
  subtree: "Subtree",
  branch_worktree: "Branch/worktree",
  mission: "Mission",
  provider_model: "Provider/model",
};

export const VAULT_SCOPES = ["user_global", "project", "agent", "team", "temporary_context"] as const;

export const memoryApi = {
  create(projectId: string, input: { scope: string; content: string; pinned?: boolean }) {
    return api.post(`/api/projects/${encodeURIComponent(projectId)}/memory`, input, MemoryEntrySchema);
  },
  setEnabled(id: string, projectId: string, enabled: boolean) {
    return api.patch(`/api/memory/${encodeURIComponent(id)}`, { projectId, enabled }, MemoryEntrySchema);
  },
  setPinned(id: string, projectId: string, pinned: boolean) {
    return api.patch(`/api/memory/${encodeURIComponent(id)}`, { projectId, pinned }, MemoryEntrySchema);
  },
  remove(id: string, projectId: string) {
    return api.deleteWithBody(`/api/memory/${encodeURIComponent(id)}`, { projectId }, z.object({}).nullable());
  },
  exportEntries(projectId: string) {
    return api.get(
      `/api/projects/${encodeURIComponent(projectId)}/memory/export`,
      z.object({ version: z.literal(1), exportedAt: z.string(), entries: MemoryEntrySchema.array() }),
    );
  },
  importEntries(projectId: string, entries: unknown[]) {
    return api.post(
      `/api/projects/${encodeURIComponent(projectId)}/memory/import`,
      { entries },
      z.object({ version: z.literal(1), importedCount: z.number(), skippedCount: z.number() }),
    );
  },
};

export { MemoryScopeSchema };
