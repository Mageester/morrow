import { ProviderStatusSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const providerKeys = {
  all: ["providers"] as const,
};

export const providerQueries = {
  list() {
    return queryOptions({
      queryKey: providerKeys.all,
      queryFn: () => api.get("/api/providers", ProviderStatusSchema.array()),
      // Provider setup changes rarely; a short stale window avoids hammering
      // the endpoint from every composer render while staying fresh enough
      // for the "no model connected" banner to clear right after setup.
      staleTime: 15_000,
    });
  },
};
