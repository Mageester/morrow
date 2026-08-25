import { ProjectSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export interface ProjectSelection {
  id: string;
  name: string;
}

export const ProjectStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspacePath: z.string(),
  accessible: z.boolean(),
  gitDetected: z.boolean(),
  branch: z.string().nullable(),
});

export const ProjectFolderSelectionSchema = z.object({
  path: z.string().nullable(),
  name: z.string().nullable(),
});

export type ProjectFolderSelection = z.infer<typeof ProjectFolderSelectionSchema>;

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const projectQueries = {
  list() {
    return queryOptions({
      queryKey: ["projects", "available"] as const,
      queryFn: async (): Promise<ProjectSelection[]> => {
        const projects = await api.get("/api/projects", ProjectSchema.array());
        // Workspace paths are only needed by the service. Do not retain them in
        // the browser query cache when Home only needs a project identifier.
        return projects.map(({ id, name }) => ({ id, name }));
      },
    });
  },
  status(projectId: string) {
    return queryOptions({
      queryKey: ["projects", "status", projectId] as const,
      queryFn: () =>
        api.get(`/api/projects/${encodeURIComponent(projectId)}/status`, ProjectStatusSchema),
      enabled: Boolean(projectId),
    });
  },
};

export const projectApi = {
  pickFolder(): Promise<ProjectFolderSelection> {
    return api.post("/api/projects/pick-folder", {}, ProjectFolderSelectionSchema);
  },
  create(input: { name: string; workspacePath: string }): Promise<ProjectSelection> {
    return api.post("/api/projects", input, ProjectSchema);
  },
  delete(projectId: string): Promise<{ ok: boolean; deletedId: string }> {
    return api.delete(`/api/projects/${encodeURIComponent(projectId)}`, z.object({ ok: z.boolean(), deletedId: z.string() }));
  },
};
