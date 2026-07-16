import type { ModelInfo, ProviderId, ProviderStatus, RouteReasoningCapability, ReasoningEffort } from "@morrow/contracts";

type Pricing = NonNullable<ModelInfo["pricing"]>;

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
  }
): ModelInfo {
  return {
    version: 1,
    id,
    canonicalId: id,
    aliases: opts.aliases ?? [],
    providerId,
    label,
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

export const BUILT_IN_MODELS: ModelInfo[] = [
  // OpenAI (reasoning models expose discrete effort levels via reasoning_effort)
  model("openai", "gpt-5.5", "GPT-5.5", { aliases: ["gpt5.5"], vision: true, speed: "powerful", cost: "high", reasoning: effort() }),
  model("openai", "gpt-5.4", "GPT-5.4", { aliases: ["gpt5.4"], vision: true, speed: "powerful", cost: "medium", reasoning: effort() }),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", { aliases: ["gpt5.4-mini"], vision: true, speed: "fast", cost: "low", reasoning: effort() }),

  // Anthropic
  model("anthropic", "claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", { contextWindow: 200000, vision: true, speed: "powerful", cost: "medium" }),
  model("anthropic", "claude-3-5-haiku-20241022", "Claude 3.5 Haiku", { contextWindow: 200000, vision: true, speed: "fast", cost: "low" }),
  model("anthropic", "claude-3-opus-20240229", "Claude 3 Opus", { contextWindow: 200000, vision: true, speed: "powerful", cost: "high" }),

  // Gemini
  model("gemini", "gemini-1.5-pro", "Gemini 1.5 Pro", { contextWindow: 2000000, vision: true, speed: "powerful", cost: "medium" }),
  model("gemini", "gemini-1.5-flash", "Gemini 1.5 Flash", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),
  model("gemini", "gemini-2.0-flash", "Gemini 2.0 Flash", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),

  // OpenRouter (aggregated upstreams)
  model("openrouter", "openrouter/auto", "OpenRouter Auto", { tokenUsage: true, streamingUsage: true, speed: "balanced", cost: "unknown" }),
  model("openrouter", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (via OpenRouter)", { contextWindow: 1000000, speed: "powerful", cost: "low" }),
  model("openrouter", "deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (via OpenRouter)", { contextWindow: 1000000, speed: "fast", cost: "low" }),
  model("openrouter", "anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet (via OpenRouter)", { contextWindow: 200000, vision: true, speed: "powerful", cost: "medium" }),
  model("openrouter", "openai/gpt-5.4", "GPT-5.4 (via OpenRouter)", { vision: true, speed: "powerful", cost: "medium", reasoning: effort() }),
  model("openrouter", "google/gemini-flash-1.5", "Gemini Flash 1.5 (via OpenRouter)", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),

  // DeepSeek
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", { aliases: ["deepseek-pro"], contextWindow: 1000000, speed: "powerful", cost: "low" }),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", { aliases: ["deepseek-flash"], contextWindow: 1000000, speed: "fast", cost: "low" }),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", { speed: "balanced", cost: "low" }),
  // The reasoner always thinks; the depth is fixed by the provider, not caller-tunable.
  model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { speed: "powerful", cost: "low", reasoning: fixedReasoning() }),

  // Ollama (local)
  model("ollama", "llama3.1", "Llama 3.1 (local)", { contextWindow: 128000, pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "qwen2.5", "Qwen 2.5 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "mistral", "Mistral (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
  model("ollama", "phi3", "Phi-3 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
];

export function unknownModel(providerId: string, id: string): ModelInfo {
  return {
    version: 1,
    id,
    canonicalId: id,
    aliases: [],
    providerId: providerId as ProviderId,
    label: id,
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: false,
    streamingUsage: false,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    speedClass: "unknown",
    costClass: "unknown",
    privacy: providerId === "ollama" ? "local" : "remote",
    builtIn: false,
    // A model the registry has never heard of: its reasoning surface is
    // genuinely unknown, never assumed to match a family default.
    reasoning: UNKNOWN_REASONING,
  };
}

export function listModels(): ModelInfo[] {
  return BUILT_IN_MODELS;
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
  const exact = BUILT_IN_MODELS.find((m) => m.providerId === providerId && m.id === normalized);
  if (exact) return exact;
  const alias = BUILT_IN_MODELS.find((m) => m.providerId === providerId && m.aliases.includes(normalized));
  if (alias) return alias;
  return unknownModel(providerId, normalized);
}

export function getModel(id: string): ModelInfo | undefined {
  return BUILT_IN_MODELS.find((m) => m.id === id || m.aliases.includes(id));
}

export function listModelsForProvider(providerId: ProviderId): ModelInfo[] {
  return BUILT_IN_MODELS.filter((m) => m.providerId === providerId);
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
    .filter((p) => p.configured && p.defaultModel && listModelsForProvider(p.id).length === 0)
    .map((p) => unknownModel(p.id, p.defaultModel!));
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
