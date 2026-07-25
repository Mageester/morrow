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
  effectiveRequestLimitTokens: number;
  effectiveLimitSource: ContextLimitSource;
  outputReserveTokens: number;
  maximumInputTokens: number;
  fallbackLimitTokens: number | null;
  /**
   * Demarcates which unverified-route category the conservative fallback (if
   * any) was sourced from. Lets the diagnostic, telemetry, and the upcoming
   * OpenCode Go live-discovery path distinguish "fallback because no Zen
   * route metadata is available" from "fallback because some custom OpenAI-
   * compatible endpoint has no declared limit" — WITHOUT fabricating per-slug
   * context limits. Different identities mean different fixes: Zen/Go need
   * live discovery; arbitrary custom endpoints need a user-supplied override.
   */
  routeFallbackIdentity: RouteFallbackIdentity;
}

/**
 * Class of provider route the conservative safe fallback applies to, when no
 * authoritative metadata is available. This is *provenance*, not a context
 * limit — the fallback number itself remains the single conservative constant
 * until live discovery or a user override replaces it.
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
  const host = (input.host ?? "").toLowerCase();
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    // Zen and Go currently share the opencode.ai host. The OpenCode Zen auth
    // flow historically lands as the openai-compatible provider's authMode
    // "opencode-zen"; OpenCode Go is being added as a separate first-class
    // provider (see services/orchestrator/src/provider/registry.ts). Until a
    // route-discovery record explicitly disambiguates, conservatively demarcate
    // known opencode.ai hosts as the Zen route — the OpenCode Go provider path
    // carries its own auth and identity, so this branch is only reached by the
    // legacy openai-compatible-talking-to-Zen route.
    return "opencode-zen";
  }
  return "custom-compatible";
}

const DEFAULT_SAFE_FALLBACK_TOKENS = 32_768;

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
 * capacities remain null; the labelled conservative fallback is only the
 * internal admission ceiling when neither route nor model has a verified value.
 */
export function resolveEffectiveContext(input: EffectiveContextInput): EffectiveContextResolution {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  const advertised = positiveInteger(metadata.contextWindow, "model context capacity");
  const endpointLimit = positiveInteger(input.endpoint.limitTokens, "endpoint context limit");
  const outputReserveTokens = positiveInteger(input.outputReserveTokens, "output reserve") ?? 0;
  const fallback = positiveInteger(input.fallbackLimitTokens ?? DEFAULT_SAFE_FALLBACK_TOKENS, "fallback context limit")!;

  const candidates: Array<{ tokens: number; source: ContextLimitSource }> = [];
  if (advertised !== null) candidates.push({ tokens: advertised, source: "model-metadata" });
  if (endpointLimit !== null) candidates.push({ tokens: endpointLimit, source: input.endpoint.limitSource });

  // A custom/injected route with no verified endpoint ceiling must not inherit
  // marketing metadata from a model served by some other route.
  if (endpointLimit === null && input.endpoint.kind !== "default") {
    candidates.length = 0;
  }
  if (candidates.length === 0) candidates.push({ tokens: fallback, source: "fallback" });
  const effective = candidates.reduce((smallest, candidate) => candidate.tokens < smallest.tokens ? candidate : smallest);
  if (outputReserveTokens >= effective.tokens) {
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
    effectiveRequestLimitTokens: effective.tokens,
    effectiveLimitSource: effective.source,
    outputReserveTokens,
    maximumInputTokens: effective.tokens - outputReserveTokens,
    fallbackLimitTokens: effective.source === "fallback" ? fallback : null,
    routeFallbackIdentity: classifyRouteFallbackIdentity({
      endpointKind: input.endpoint.kind,
      host: input.endpoint.host,
      providerId: input.providerId,
    }),
  };
}
