import {
  ProviderStatusSchema,
  ProviderTestResultSchema,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
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

const ConfigureProviderResponseSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("openrouter"),
    status: ProviderStatusSchema.nullable(),
  })
  .passthrough();

const DisconnectProviderResponseSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("openrouter"),
    removed: z.boolean(),
    status: ProviderStatusSchema.nullable(),
  })
  .passthrough();

/**
 * Credential-bearing requests stay outside React Query. React Query retains
 * mutation variables for inspection/retry, which would make an API key
 * browser-resident longer than the single request that must carry it.
 */
export const openRouterApi = {
  configure(apiKey: string) {
    return api.post(
      "/api/providers/openrouter/configure",
      { apiKey },
      ConfigureProviderResponseSchema,
    );
  },
  test() {
    return api.post(
      "/api/providers/openrouter/test",
      {},
      ProviderTestResultSchema,
    );
  },
  refresh() {
    return api.post(
      "/api/providers/openrouter/models/refresh",
      {},
      ProviderTestResultSchema,
    );
  },
  disconnect() {
    return api.delete(
      "/api/providers/openrouter/credentials",
      DisconnectProviderResponseSchema,
    );
  },
};
