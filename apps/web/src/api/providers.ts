import {
  ProviderIdSchema,
  ProviderStatusSchema,
  ProviderTestResultSchema,
  type ProviderId,
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
    provider: ProviderIdSchema,
    status: ProviderStatusSchema.nullable(),
    securePermissions: z.boolean(),
    credentialProtection: z.enum(["windows-user-acl", "posix-mode"]),
    shadowedByEnv: z.array(z.string()),
  })
  .passthrough();

const DisconnectProviderResponseSchema = z
  .object({
    ok: z.literal(true),
    provider: ProviderIdSchema,
    removed: z.array(z.string()),
    status: ProviderStatusSchema.nullable(),
  })
  .passthrough();

export interface ProviderConfigureInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Provider operations, parameterised by provider id.
 *
 * These were hardcoded to OpenRouter — the response schemas literally asserted
 * `z.literal("openrouter")` — so the web app could configure exactly one of the
 * providers the engine supports. The underlying routes were always generic
 * (`/api/providers/:providerId/...`); only the client was narrow.
 *
 * Credential-bearing requests deliberately stay outside React Query. React
 * Query retains mutation variables for inspection and retry, which would keep
 * an API key browser-resident for longer than the single request that has to
 * carry it.
 */
export function providerApi(id: ProviderId) {
  return {
    configure(input: ProviderConfigureInput) {
      return api.post(`/api/providers/${id}/configure`, input, ConfigureProviderResponseSchema);
    },
    test() {
      return api.post(`/api/providers/${id}/test`, {}, ProviderTestResultSchema);
    },
    refresh() {
      return api.post(`/api/providers/${id}/models/refresh`, {}, ProviderTestResultSchema);
    },
    disconnect() {
      return api.delete(`/api/providers/${id}/credentials`, DisconnectProviderResponseSchema);
    },
  };
}

/** Retained for callers written before the generalisation. */
export const openRouterApi = {
  configure: (apiKey: string) => providerApi("openrouter").configure({ apiKey }),
  test: () => providerApi("openrouter").test(),
  refresh: () => providerApi("openrouter").refresh(),
  disconnect: () => providerApi("openrouter").disconnect(),
};
