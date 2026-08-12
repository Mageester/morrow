import { GlobalSearchResponseSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const searchQueries = {
  global(query: string) {
    const normalized = query.trim();
    return queryOptions({
      queryKey: ["search", "global", normalized] as const,
      queryFn: () => api.get(
        `/api/search?q=${encodeURIComponent(normalized)}&limit=30`,
        GlobalSearchResponseSchema,
      ),
      enabled: normalized.length >= 2,
      staleTime: 15_000,
    });
  },
};
