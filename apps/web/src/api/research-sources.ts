import { ResearchSourcesResponseSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const researchSourceQueries = {
  forTask(taskId: string) {
    return queryOptions({
      queryKey: ["task", taskId, "research-sources"] as const,
      queryFn: () => api.get(`/api/tasks/${encodeURIComponent(taskId)}/sources`, ResearchSourcesResponseSchema),
      staleTime: 30_000,
    });
  },
};
