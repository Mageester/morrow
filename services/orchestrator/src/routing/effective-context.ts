import type { ContextLimitSource, ProviderProtocol } from "../provider/base.js";
import { resolveModelMetadata } from "./models.js";
import { createHash } from "node:crypto";

export interface EffectiveContextEndpointInput {
  kind: "default" | "custom" | "injected";
  host: string | null;
  protocol: ProviderProtocol;
  limitTokens: number | null;
  limitSource: ContextLimitSource;
}

export interface EffectiveContextInput {
  providerId: string;
  selectedModel: string;
  endpoint: EffectiveContextEndpointInput;
  outputReserveTokens: number;
  /** Kept for API compatibility; it is never promoted to a provider limit. */
  fallbackLimitTokens?: number;
}

export interface EffectiveContextResolution {
  selectedModelId: string;
  canonicalModelId: string;
  providerId: string;
  endpointKind: EffectiveContextEndpointInput["kind"];
  endpointHost: string | null;
  protocol: ProviderProtocol;
  advertisedModelCapacityTokens: number | null;
  advertisedModelCapacitySource: ContextLimitSource;
  configuredEndpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;
  effectiveRequestLimitTokens: number | null;
  effectiveLimitSource: ContextLimitSource;
  outputReserveTokens: number;
  maximumInputTokens: number | null;
  fallbackLimitTokens: number | null;
}

export function providerRouteFingerprint(input: {
  providerId: string;
  model: string;
  protocol: ProviderProtocol;
  endpointKind: EffectiveContextEndpointInput["kind"];
  endpointHost: string | null;
  endpointIdentityHash?: string | null | undefined;
}): string {
  const canonicalModel = resolveModelMetadata(input.providerId, input.model).canonicalId;
  return createHash("sha256").update(JSON.stringify({
    providerId: input.providerId,
    canonicalModel,
    protocol: input.protocol,
    endpointKind: input.endpointKind,
    endpointHost: input.endpointHost?.toLowerCase() ?? null,
    endpointIdentityHash: input.endpointIdentityHash ?? null,
  })).digest("hex");
}

function positiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

/**
 * Resolve the request ceiling for the exact provider route. Publicly unknown
 * capacities remain null. An internal convenience value must never become a
 * provider admission ceiling.
 */
export function resolveEffectiveContext(input: EffectiveContextInput): EffectiveContextResolution {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  const advertised = positiveInteger(metadata.contextWindow, "model context capacity");
  const endpointLimit = positiveInteger(input.endpoint.limitTokens, "endpoint context limit");
  const outputReserveTokens = positiveInteger(input.outputReserveTokens, "output reserve") ?? 0;

  const candidates: Array<{ tokens: number; source: ContextLimitSource }> = [];
  if (advertised !== null) candidates.push({ tokens: advertised, source: "model-metadata" });
  if (endpointLimit !== null) candidates.push({ tokens: endpointLimit, source: input.endpoint.limitSource });

  // A custom/injected route with no verified endpoint ceiling must not inherit
  // marketing metadata from a model served by some other route.
  if (endpointLimit === null && input.endpoint.kind !== "default" && input.providerId !== "mock" && input.providerId !== "deterministic-local") {
    candidates.length = 0;
  }
  const effective = candidates.length ? candidates.reduce((smallest, candidate) => candidate.tokens < smallest.tokens ? candidate : smallest) : null;
  if (effective && outputReserveTokens >= effective.tokens) {
    throw new Error(`Output reserve (${outputReserveTokens}) must be smaller than effective context limit (${effective.tokens})`);
  }

  return {
    selectedModelId: input.selectedModel,
    canonicalModelId: metadata.canonicalId,
    providerId: input.providerId,
    endpointKind: input.endpoint.kind,
    endpointHost: input.endpoint.host,
    protocol: input.endpoint.protocol,
    advertisedModelCapacityTokens: advertised,
    advertisedModelCapacitySource: advertised === null ? "unknown" : "model-metadata",
    configuredEndpointLimitTokens: endpointLimit,
    endpointLimitSource: endpointLimit === null ? "unknown" : input.endpoint.limitSource,
    effectiveRequestLimitTokens: effective?.tokens ?? null,
    effectiveLimitSource: effective?.source ?? "unknown",
    outputReserveTokens,
    maximumInputTokens: effective ? effective.tokens - outputReserveTokens : null,
    fallbackLimitTokens: null,
  };
}
