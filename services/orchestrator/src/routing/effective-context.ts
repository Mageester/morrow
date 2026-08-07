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
  // The new first-class OpenCode Go provider carries the `opencode-go` id and
  // its own auth/identity; before any per-slug metadata is discovered, its
  // route is demarcated explicitly as the OpenCode Go subscription path.
  if (input.providerId === "opencode-go") return "opencode-go";
  const host = (input.host ?? "").toLowerCase();
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    // The OpenCode Zen route (the legacy openai-compatible-talking-to-Zen
    // path) shares the opencode.ai host with Go, but the Go provider
    // demultiplexes by provider id before this branch is reached. The Zen
    // route is therefore the only "opencode.ai" demarcation left.
    return "opencode-zen";
  }
  return "custom-compatible";
}

const DEFAULT_SAFE_FALLBACK_TOKENS = 32_768;

/**
 * Host names whose first-class provider identity is published and well-known
 * (verified via the OpenCode provider catalog at https://models.dev/api.json
 * and the live `/v1/models` endpoints). For these, an operator-configured
 * custom endpoint without a per-route limit may still safely inherit
 * per-slug contextWindow from the model metadata, because the route IS the
 * model — there is no separate marketing endpoint the metadata could be
 * talking about. Any non-matching host (e.g. a private deployment) falls
 * back to the safe wipe.
 */
const KNOWN_PUBLISHED_OPENCODE_HOSTS = new Set<string>(["opencode.ai"]);

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
  // A provider-declared default-route ceiling is a *fallback for models we have
  // no metadata about*, not a cap on the ones we do. Treating it as a cap is how
  // DeepSeek V4's published 1,000,000-token window silently became 131,072: the
  // bundled per-provider constant predated the model and won the `min` below on
  // every request. The result was compaction roughly eight times sooner than the
  // route required and, at the extreme, a 148,403-token request refused against
  // a limit the provider would have accepted.
  //
  // An `endpoint-override` is different in kind and still caps: the operator
  // configured that number deliberately (DEEPSEEK_CONTEXT_LIMIT and friends),
  // and narrowing a window on request is exactly what it is for.
  const endpointLimitIsFallbackOnly =
    input.endpoint.kind === "default"
    && input.endpoint.limitSource === "provider-metadata"
    && advertised !== null;
  if (endpointLimit !== null && !endpointLimitIsFallbackOnly) {
    candidates.push({ tokens: endpointLimit, source: input.endpoint.limitSource });
  }

  // A custom/injected route with no verified endpoint ceiling must not inherit
  // marketing metadata from a model served by some other route. The single
  // exception: a first-class provider that publishes a default base URL and
  // the operator has not overridden it — for those the route identity is
  // trusted because the provider's catalog and the endpoint are the same
  // contract (we have no other route for that model). The host check is
  // exact: any explicit operator override (different host) reverts to the
  // safe wipe.
  const isTrustedKnownProviderRoute =
    (input.providerId === "opencode-go" || input.providerId === "openai-compatible") &&
    input.endpoint.host !== null &&
    KNOWN_PUBLISHED_OPENCODE_HOSTS.has(input.endpoint.host.toLowerCase());
  if (endpointLimit === null && input.endpoint.kind !== "default" && !isTrustedKnownProviderRoute) {
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
