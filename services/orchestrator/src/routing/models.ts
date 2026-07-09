import type { ModelInfo, ProviderId } from "@morrow/contracts";

type Pricing = NonNullable<ModelInfo["pricing"]>;

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
  };
}

const freeLocal: Pricing = {
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  source: "authoritative",
};

export const BUILT_IN_MODELS: ModelInfo[] = [
  // OpenAI
  model("openai", "gpt-5.5", "GPT-5.5", { aliases: ["gpt5.5"], vision: true, speed: "powerful", cost: "high" }),
  model("openai", "gpt-5.4", "GPT-5.4", { aliases: ["gpt5.4"], vision: true, speed: "powerful", cost: "medium" }),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", { aliases: ["gpt5.4-mini"], vision: true, speed: "fast", cost: "low" }),

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
  model("openrouter", "openai/gpt-5.4", "GPT-5.4 (via OpenRouter)", { vision: true, speed: "powerful", cost: "medium" }),
  model("openrouter", "google/gemini-flash-1.5", "Gemini Flash 1.5 (via OpenRouter)", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),

  // DeepSeek
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", { aliases: ["deepseek-pro"], contextWindow: 1000000, speed: "powerful", cost: "low" }),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", { aliases: ["deepseek-flash"], contextWindow: 1000000, speed: "fast", cost: "low" }),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", { speed: "balanced", cost: "low" }),
  model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { speed: "powerful", cost: "low" }),

  // Ollama (local)
  model("ollama", "llama3.1", "Llama 3.1 (local)", { contextWindow: 128000, pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "qwen2.5", "Qwen 2.5 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "mistral", "Mistral (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
  model("ollama", "phi3", "Phi-3 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
];

function unknownModel(providerId: string, id: string): ModelInfo {
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
  };
}

export function listModels(): ModelInfo[] {
  return BUILT_IN_MODELS;
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
