import type { ModelInfo, ProviderId, RouteReasoningCapability } from "@morrow/contracts";

export const BUNDLED_MODEL_CATALOG_VERSION = "2026-07-16";
type Pricing = NonNullable<ModelInfo["pricing"]>;

export const freeLocal: Pricing = {
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  source: "authoritative",
};

export const price = (inputUsdPerMillion: number, outputUsdPerMillion: number, cachedInputUsdPerMillion?: number): Pricing => ({
  inputUsdPerMillion,
  outputUsdPerMillion,
  ...(cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion }),
  source: "authoritative",
});

// Compatibility view: legacy pickers render an unknown route as "not
// configurable". The provider-owned exact capability contract carries the
// stronger distinction as an unknown fact, so this projection does not claim
// that the provider explicitly disabled reasoning.
export const UNKNOWN_REASONING: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "unknown" };

export function effort(levels: string[] = ["low", "medium", "high"]): RouteReasoningCapability {
  return { control: "effort", efforts: levels, budgets: [], source: "registry" };
}

export function deepSeekReasoning(): RouteReasoningCapability {
  return {
    control: "effort",
    efforts: ["low", "high", "xhigh", "max"],
    budgets: [],
    source: "provider-metadata",
    supportsOff: true,
    wire: "deepseek-thinking",
  };
}

export function fixedReasoning(): RouteReasoningCapability {
  return { control: "fixed", efforts: [], budgets: [], source: "registry" };
}

export function noReasoning(): RouteReasoningCapability {
  return { control: "none", efforts: [], budgets: [], source: "registry" };
}

export function model(
  providerId: ProviderId,
  id: string,
  label: string,
  opts: {
    aliases?: string[];
    canonicalTarget?: { providerId: ProviderId; modelId: string };
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    pricing?: Pricing | null;
    tokenUsage?: boolean;
    streamingUsage?: boolean;
    streaming?: boolean;
    toolCalls?: boolean;
    vision?: boolean;
    speed?: ModelInfo["speedClass"];
    cost?: ModelInfo["costClass"];
    privacy?: ModelInfo["privacy"];
    reasoning?: RouteReasoningCapability;
    family?: string | null;
    generation?: string | null;
    lifecycle?: ModelInfo["lifecycle"];
    metadataSource?: ModelInfo["metadataSource"];
    confidence?: ModelInfo["confidence"];
  } = {},
): ModelInfo {
  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
    ...(opts.canonicalTarget ? { canonicalTarget: opts.canonicalTarget } : {}),
    aliases: opts.aliases ?? [],
    providerId,
    label,
    family: opts.family ?? null,
    generation: opts.generation ?? null,
    lifecycle: opts.lifecycle ?? "current",
    contextWindow: opts.contextWindow ?? null,
    maxOutputTokens: opts.maxOutputTokens ?? null,
    pricing: opts.pricing ?? null,
    tokenUsage: opts.tokenUsage ?? true,
    streamingUsage: opts.streamingUsage ?? true,
    capabilities: {
      streaming: opts.streaming ?? true,
      toolCalls: opts.toolCalls ?? true,
      vision: opts.vision ?? false,
    },
    speedClass: opts.speed ?? "unknown",
    costClass: opts.cost ?? "unknown",
    privacy: opts.privacy ?? "remote",
    builtIn: true,
    capabilitySource: opts.metadataSource === "remote-catalog" ? "remote-catalog" : "bundled-catalog",
    metadataSource: opts.metadataSource ?? "bundled-catalog",
    metadataVersion: BUNDLED_MODEL_CATALOG_VERSION,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    confidence: opts.confidence ?? "verified",
    reasoning: opts.reasoning ?? noReasoning(),
  };
}
