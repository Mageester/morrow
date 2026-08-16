import type { ContextLimitSource, ProviderProtocol } from "../provider/base.js";
import { resolveModelMetadata } from "./models.js";
import { observedContextLimitByIdentity } from "../provider/context-limit-discovery.js";
import { createHash } from "node:crypto";

export interface EffectiveContextEndpointInput {
  kind: "default" | "custom" | "injected";
  host: string | null;
  protocol: ProviderProtocol;
  limitTokens: number | null;
  limitSource: ContextLimitSource;
  /** One-way identity of the configured base route. Supplying it lets
   * resolution pick up a capacity this exact endpoint has already stated about
   * itself in an over-limit rejection. */
  endpointIdentityHash?: string | null | undefined;
}

export interface EffectiveContextInput {
  providerId: string;
  selectedModel: string;
  endpoint: EffectiveContextEndpointInput;
  outputReserveTokens: number;
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
  /**
   * Demarcates which unverified-route category the conservative fallback (if
   * any) was sourced from. Lets the diagnostic, telemetry, and discovery
   * paths distinguish route categories without fabricating per-slug context limits.
   */
  routeFallbackIdentity: RouteFallbackIdentity;
}

/**
 * Class of provider route the conservative safe fallback applies to, when no
 * authoritative metadata is available. This is *provenance*, not a context
 * limit.
 *
 *   "opencode-zen"      — opencode.ai host, opencode-zen subscription route
 *   "opencode-go"       — opencode.ai host, opencode-go subscription route
 *   "custom-compatible" — any other OpenAI-compatible bring-your-own endpoint
 *   "generic"            — bundled provider with no custom endpoint (deepseek,
 *                         anthropic, openai, gemini, openrouter, ollama, …)
 */
export type RouteFallbackIdentity =
  | "opencode-zen"
  | "opencode-go"
  | "custom-compatible"
  | "generic";

export function classifyRouteFallbackIdentity(input: {
  endpointKind: EffectiveContextEndpointInput["kind"];
  host: string | null;
  providerId: string;
}): RouteFallbackIdentity {
  if (input.endpointKind === "default") return "generic";
  if (input.providerId === "opencode-go") return "opencode-go";
  const host = (input.host ?? "").toLowerCase();
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    return "opencode-zen";
  }
  return "custom-compatible";
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
 * Resolve the request ceiling for the exact provider route. Unknown
 * capacities remain null; effective limit is the minimum of known limits
 * (native model context and route/endpoint limit). If nothing authoritative is
 * known, returns unknown (never a guessed 32k fallback).
 */
export function resolveEffectiveContext(input: EffectiveContextInput): EffectiveContextResolution {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  const advertised = positiveInteger(metadata.contextWindow, "model context capacity");
  const endpointLimit = positiveInteger(input.endpoint.limitTokens, "endpoint context limit");
  const outputReserveTokens = positiveInteger(input.outputReserveTokens, "output reserve") ?? 0;
  const fallback = positiveInteger(input.fallbackLimitTokens, "fallback context limit");

  const advertisedSource: ContextLimitSource = advertised !== null
    ? (metadata.metadataSource === "provider-reported" ? "provider-metadata" : "model-metadata")
    : "unknown";
  // A capacity this exact endpoint stated in its own over-limit rejection is
  // the strongest route-level fact available: it describes what the deployment
  // actually enforces, which a model-name catalog entry cannot know and most
  // model listings never disclose. It joins as a ROUTE limit, not a native one
  // — the model behind a capped gateway is still whatever size it is.
  const observed = observedContextLimitByIdentity(input.endpoint.endpointIdentityHash, input.selectedModel);
  const observedTokens = positiveInteger(observed?.tokens ?? null, "observed context limit");
  const configuredEndpointLimit = endpointLimit;
  const routeLimit = observedTokens !== null && (configuredEndpointLimit === null || observedTokens < configuredEndpointLimit)
    ? observedTokens
    : configuredEndpointLimit;
  const endpointSource: ContextLimitSource = routeLimit === null
    ? "unknown"
    : routeLimit === observedTokens && routeLimit !== configuredEndpointLimit
      ? "provider-metadata"
      : input.endpoint.limitSource;

  const candidates: Array<{ tokens: number; source: ContextLimitSource }> = [];
  if (advertised !== null) candidates.push({ tokens: advertised, source: advertisedSource });
  if (routeLimit !== null) candidates.push({ tokens: routeLimit, source: endpointSource });
  if (candidates.length === 0 && fallback !== null) candidates.push({ tokens: fallback, source: "fallback" });

  let effective: { tokens: number; source: ContextLimitSource } | null = null;
  if (candidates.length > 0) {
    effective = candidates.reduce((smallest, candidate) => candidate.tokens < smallest.tokens ? candidate : smallest);
  }

  if (effective !== null && outputReserveTokens >= effective.tokens) {
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
    advertisedModelCapacitySource: advertisedSource,
    configuredEndpointLimitTokens: routeLimit,
    endpointLimitSource: endpointSource,
    effectiveRequestLimitTokens: effective?.tokens ?? null,
    effectiveLimitSource: effective?.source ?? "unknown",
    outputReserveTokens,
    maximumInputTokens: effective !== null ? effective.tokens - outputReserveTokens : null,
    fallbackLimitTokens: effective?.source === "fallback" ? fallback : null,
    routeFallbackIdentity: classifyRouteFallbackIdentity({
      endpointKind: input.endpoint.kind,
      host: input.endpoint.host,
      providerId: input.providerId,
    }),
  };
}
