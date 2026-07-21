import { ProjectSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export interface ProjectSelection {
  id: string;
  name: string;
}

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
};
