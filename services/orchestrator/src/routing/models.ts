import type { ModelInfo, ModelStatus, ProviderId, ProviderStatus, RouteReasoningCapability, ReasoningEffort } from "@morrow/contracts";
import type { ProviderModelDiscovery } from "../repositories/provider-model-discovery.js";

type Pricing = NonNullable<ModelInfo["pricing"]>;
export const BUNDLED_MODEL_CATALOG_VERSION = "2026-07-16";

// ── Reasoning capability, with provenance ────────────────────────────────────
//
// The built-in registry is the lowest-priority ("registry") source of reasoning
// truth; a live provider probe or provider-returned metadata (higher priority)
// would override it. When nothing is known the capability is an explicit
// "unknown/none" — never a guessed control surface.
export const UNKNOWN_REASONING: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "unknown" };

function effort(levels: ReasoningEffort[] = ["low", "medium", "high"]): RouteReasoningCapability {
  return { control: "effort", efforts: levels, budgets: [], source: "registry" };
}
function fixedReasoning(): RouteReasoningCapability {
  return { control: "fixed", efforts: [], budgets: [], source: "registry" };
}
function noReasoning(): RouteReasoningCapability {
  return { control: "none", efforts: [], budgets: [], source: "registry" };
}

/**
 * Authoritative model metadata registry.
 *
 * The registry is deliberately conservative: unknown context windows, pricing,
 * and usage capabilities stay unknown instead of being inferred from provider
 * families or marketing copy. Custom model IDs are still allowed; they resolve
 * to safe metadata with nullable limits and no pricing.
 */
function model(
  providerId: ProviderId,
  id: string,
  label: string,
  opts: {
    aliases?: string[];
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
  }
): ModelInfo {
  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
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
    // Default: no reasoning controls. Only models with a known reasoning
    // surface opt in below — the registry never claims a control it can't back.
    reasoning: opts.reasoning ?? noReasoning(),
  };
}

const freeLocal: Pricing = {
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  source: "authoritative",
};

const price = (inputUsdPerMillion: number, outputUsdPerMillion: number, cachedInputUsdPerMillion?: number): Pricing => ({
  inputUsdPerMillion,
  outputUsdPerMillion,
  ...(cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion }),
  source: "authoritative",
});

export const BUILT_IN_MODELS: ModelInfo[] = [
  // OpenAI API catalog. Account availability is discovered separately.
  model("openai", "gpt-5.6-sol", "GPT-5.6 Sol", { aliases: ["gpt-5.6", "gpt5.6"], family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(5, 30, 0.5), vision: true, speed: "powerful", cost: "high", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.6-terra", "GPT-5.6 Terra", { family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(2.5, 15), vision: true, speed: "balanced", cost: "medium", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.6-luna", "GPT-5.6 Luna", { family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(1, 6), vision: true, speed: "fast", cost: "low", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.5", "GPT-5.5", { aliases: ["gpt5.5"], family: "gpt-5.5", generation: "5.5", lifecycle: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(5, 30, 0.5), vision: true, speed: "powerful", cost: "high", reasoning: effort() }),
  model("openai", "gpt-5.4", "GPT-5.4", { aliases: ["gpt5.4"], family: "gpt-5.4", generation: "5.4", lifecycle: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(2.5, 15, 0.25), vision: true, speed: "powerful", cost: "medium", reasoning: effort() }),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", { aliases: ["gpt5.4-mini"], family: "gpt-5.4", generation: "5.4", lifecycle: "legacy", vision: true, speed: "fast", cost: "low", reasoning: effort() }),

  // Anthropic
  model("anthropic", "claude-fable-5", "Claude Fable 5", { family: "claude-fable", generation: "5", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(10, 50), vision: true, speed: "powerful", cost: "high", reasoning: fixedReasoning() }),
  model("anthropic", "claude-opus-4-8", "Claude Opus 4.8", { family: "claude-opus", generation: "4.8", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(5, 25), vision: true, speed: "powerful", cost: "high", reasoning: effort() }),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5", { family: "claude-sonnet", generation: "5", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(3, 15), vision: true, speed: "fast", cost: "medium", reasoning: effort() }),
  model("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", { aliases: ["claude-haiku-4-5"], family: "claude-haiku", generation: "4.5", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: price(1, 5), vision: true, speed: "fast", cost: "low" }),

  // Gemini
  model("gemini", "gemini-3.5-flash", "Gemini 3.5 Flash", { family: "gemini-flash", generation: "3.5", vision: true, speed: "powerful", cost: "unknown", reasoning: fixedReasoning() }),
  model("gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", { family: "gemini-pro", generation: "3.1", lifecycle: "preview", vision: true, speed: "powerful", cost: "unknown", reasoning: fixedReasoning() }),
  model("gemini", "gemini-2.5-flash", "Gemini 2.5 Flash", { family: "gemini-flash", generation: "2.5", vision: true, speed: "fast", cost: "low", reasoning: fixedReasoning() }),
  model("gemini", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", { family: "gemini-flash-lite", generation: "2.5", vision: true, speed: "fast", cost: "low", reasoning: fixedReasoning() }),

  // OpenRouter (aggregated upstreams)
  model("openrouter", "openrouter/auto", "OpenRouter Auto", { tokenUsage: true, streamingUsage: true, speed: "balanced", cost: "unknown" }),
  model("openrouter", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (via OpenRouter)", { contextWindow: 1000000, speed: "powerful", cost: "low" }),
  model("openrouter", "deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (via OpenRouter)", { contextWindow: 1000000, speed: "fast", cost: "low" }),

  // DeepSeek
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", { aliases: ["deepseek-pro"], contextWindow: 1000000, speed: "powerful", cost: "low" }),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", { aliases: ["deepseek-flash"], contextWindow: 1000000, speed: "fast", cost: "low" }),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", { lifecycle: "deprecated", speed: "balanced", cost: "low" }),
  // The reasoner always thinks; the depth is fixed by the provider, not caller-tunable.
  model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { lifecycle: "deprecated", speed: "powerful", cost: "low", reasoning: fixedReasoning() }),

  // Ollama (local)
  model("ollama", "llama3.1", "Llama 3.1 (local)", { contextWindow: 128000, pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "qwen2.5", "Qwen 2.5 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "mistral", "Mistral (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
  model("ollama", "phi3", "Phi-3 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
];

let activeCatalogModels: ModelInfo[] = BUILT_IN_MODELS;

export function installModelCatalog(models: ModelInfo[]): void {
  const seen = new Set<string>();
  activeCatalogModels = models.filter((model) => {
    const key = `${model.providerId}\u0000${model.canonicalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function unknownModel(providerId: string, id: string): ModelInfo {
  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
    aliases: [],
    providerId: providerId as ProviderId,
    label: id,
    family: null,
    generation: null,
    lifecycle: "unknown",
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: false,
    streamingUsage: false,
    capabilities: { streaming: false, toolCalls: false, vision: false },
    capabilitySource: "unknown",
    speedClass: "unknown",
    costClass: "unknown",
    privacy: providerId === "ollama" ? "local" : "remote",
    builtIn: false,
    metadataSource: "unknown",
    metadataVersion: BUNDLED_MODEL_CATALOG_VERSION,
    fetchedAt: null,
    confidence: "unknown",
    // A model the registry has never heard of: its reasoning surface is
    // genuinely unknown, never assumed to match a family default.
    reasoning: UNKNOWN_REASONING,
  };
}

export function listModels(): ModelInfo[] {
  return activeCatalogModels;
}

/**
 * The reasoning capability for a route, resolved through the metadata
 * precedence (provider metadata → probe → registry → unknown). Today only the
 * registry and the unknown fallback are populated; higher-priority sources slot
 * in here without any caller change.
 */
export function resolveReasoningCapability(providerId: string, id: string): RouteReasoningCapability {
  return resolveModelMetadata(providerId, id).reasoning ?? UNKNOWN_REASONING;
}

export function resolveModelMetadata(providerId: string, id: string): ModelInfo {
  const normalized = id.trim();
  const exact = activeCatalogModels.find((m) => m.providerId === providerId && m.id === normalized);
  if (exact) return exact;
  const alias = activeCatalogModels.find((m) => m.providerId === providerId && m.aliases.includes(normalized));
  if (alias) return alias;
  return unknownModel(providerId, normalized);
}

export function getModel(id: string): ModelInfo | undefined {
  return activeCatalogModels.find((m) => m.id === id || m.aliases.includes(id));
}

export function listModelsForProvider(providerId: ProviderId): ModelInfo[] {
  return activeCatalogModels.filter((m) => m.providerId === providerId);
}

/**
 * Synthesized entries for configured "bring your own model" providers (today:
 * openai-compatible) that have zero built-in registry rows because their
 * model space cannot be known in advance. Without this, a correctly
 * configured openai-compatible endpoint never appears in `/api/models` or the
 * `/model` picker — the registry has nothing to return for it at all, unlike
 * providers with real registry entries where "not configured" still lists the
 * model as unavailable. Providers that already have registry entries are
 * untouched; a provider with no configured default model yields nothing.
 */
export function listConfiguredCustomModels(providers: ProviderStatus[]): ModelInfo[] {
  return providers
    .filter((p) => p.configured && p.defaultModel && !listModelsForProvider(p.id).some((model) => model.id === p.defaultModel || model.aliases.includes(p.defaultModel!)))
    .map((p) => unknownModel(p.id, p.defaultModel!));
}

/**
 * Merge the bundled catalog with the current authentication surface's durable
 * provider discovery. Credentials prove configuration only; only a successful
 * provider model-list response proves account availability.
 */
export function resolveModelStatuses(
  providers: ProviderStatus[],
  discoveries: ProviderModelDiscovery[],
): ModelStatus[] {
  const all = [...listModels(), ...listConfiguredCustomModels(providers)];
  const output: ModelStatus[] = [];
  for (const provider of providers) {
    const authMode = provider.authMode ?? "unknown";
    const discovery = discoveries.find((item) => item.providerId === provider.id && item.authMode === authMode);
    const providerModels = all.filter((model) => model.providerId === provider.id);
    const discovered = discovery?.models ?? [];

    for (const item of discovered) {
      const known = providerModels.find((model) => model.id === item.providerModelId || model.aliases.includes(item.providerModelId));
      if (known) continue;
      providerModels.push({
        ...unknownModel(provider.id, item.providerModelId),
        label: item.displayName,
        author: item.author ?? null,
        inputModalities: item.inputModalities ?? [],
        outputModalities: item.outputModalities ?? [],
        pricing: item.pricing ?? null,
        costType: item.costType ?? "unknown",
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        lifecycle: "custom",
        metadataSource: "provider-reported",
        fetchedAt: discovery?.fetchedAt ?? null,
        confidence: "reported",
      });
    }

    for (const model of providerModels) {
      const report = discovered.find((item) => item.providerModelId === model.id || model.aliases.includes(item.providerModelId));
      const resolved = report ? {
        ...model,
        providerModelId: report.providerModelId,
        label: report.displayName,
        author: report.author ?? model.author ?? null,
        inputModalities: report.inputModalities ?? model.inputModalities ?? [],
        outputModalities: report.outputModalities ?? model.outputModalities ?? [],
        pricing: report.pricing ?? model.pricing,
        costType: report.costType ?? model.costType ?? "unknown",
        contextWindow: report.contextWindow ?? model.contextWindow,
        maxOutputTokens: report.maxOutputTokens ?? model.maxOutputTokens,
        metadataSource: "provider-reported" as const,
        fetchedAt: discovery?.fetchedAt ?? model.fetchedAt,
        confidence: report.contextWindow !== null || report.maxOutputTokens !== null ? "reported" as const : model.confidence,
        capabilities: {
          streaming: report.capabilities.streaming ?? model.capabilities.streaming,
          toolCalls: report.capabilities.toolCalls ?? model.capabilities.toolCalls,
          vision: report.capabilities.vision ?? model.capabilities.vision,
          reasoning: report.capabilities.reasoning ?? null,
        },
        capabilitySource: Object.values(report.capabilities).some((value) => value !== null)
          ? "provider-reported" as const
          : model.capabilitySource,
      } : model;
      const availability = !provider.configured
        ? "unavailable" as const
        : discovery?.status === "available" && report
          ? report.availability ?? "available"
          : discovery?.status === "available"
            ? "unavailable" as const
          : discovery?.status === "unavailable"
            ? "unavailable" as const
            : "unknown" as const;
      output.push({
        model: resolved,
        available: availability === "available",
        availability,
        availabilitySource: report ? "provider-reported" : provider.configured ? "unknown" : "configured",
        availabilityReason: availability === "available"
          ? null
          : !provider.configured
            ? "Provider authentication is not configured."
            : discovery?.status === "available"
              ? "The selected model is no longer returned by the provider catalogue."
              : discovery?.status === "unavailable"
              ? `Last provider discovery failed${discovery.errorKind ? ` (${discovery.errorKind})` : ""}.`
              : "Account model availability has not been discovered yet.",
        authMode,
        fetchedAt: discovery?.fetchedAt ?? null,
      });
    }
  }
  return output;
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type UsageCost =
  | { known: true; usd: number; label: string }
  | { known: false; label: "unknown" };

export function calculateUsageCost(usage: UsageForCost, metadata: ModelInfo | undefined | null): UsageCost {
  const pricing = metadata?.pricing;
  if (!pricing || pricing.source !== "authoritative") return { known: false, label: "unknown" };
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const usd =
    (uncachedInput / 1_000_000) * pricing.inputUsdPerMillion +
    (cached / 1_000_000) * cachedRate +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return { known: true, usd, label: `$${usd.toFixed(4)}` };
}
