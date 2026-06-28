import type { ModelInfo, ModelStatus, ProviderCapabilities, ProviderId } from "@morrow/contracts";
import type { ProviderEnv } from "../provider/credentials.js";
import { getProviderStatus, listProviderStatuses } from "../provider/registry.js";

/**
 * Built-in capability metadata for known model ids. Selectable models are
 * derived from provider status; unknown provider-backed ids are shown with
 * inferred labels and conservative unknown capability metadata.
 */
function model(
  providerId: ProviderId,
  id: string,
  label: string,
  opts: {
    contextWindow?: number | null;
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
    providerId,
    label,
    contextWindow: opts.contextWindow ?? null,
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

export const BUILT_IN_MODELS: ModelInfo[] = [
  // OpenAI
  model("openai", "gpt-5.5", "GPT-5.5", { vision: true, speed: "powerful", cost: "high" }),
  model("openai", "gpt-5.4", "GPT-5.4", { vision: true, speed: "powerful", cost: "medium" }),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", { vision: true, speed: "fast", cost: "low" }),
  // Anthropic
  model("anthropic", "claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", { contextWindow: 200000, vision: true, speed: "powerful", cost: "medium" }),
  model("anthropic", "claude-3-5-haiku-20241022", "Claude 3.5 Haiku", { contextWindow: 200000, vision: true, speed: "fast", cost: "low" }),
  model("anthropic", "claude-3-opus-20240229", "Claude 3 Opus", { contextWindow: 200000, vision: true, speed: "powerful", cost: "high" }),
  // Gemini
  model("gemini", "gemini-1.5-pro", "Gemini 1.5 Pro", { contextWindow: 2000000, vision: true, speed: "powerful", cost: "medium" }),
  model("gemini", "gemini-1.5-flash", "Gemini 1.5 Flash", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),
  model("gemini", "gemini-2.0-flash", "Gemini 2.0 Flash", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),
  // OpenRouter (aggregated upstreams)
  model("openrouter", "openrouter/auto", "OpenRouter Auto", { speed: "balanced", cost: "unknown" }),
  model("openrouter", "anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet (via OpenRouter)", { contextWindow: 200000, vision: true, speed: "powerful", cost: "medium" }),
  model("openrouter", "openai/gpt-5.4", "GPT-5.4 (via OpenRouter)", { vision: true, speed: "powerful", cost: "medium" }),
  model("openrouter", "google/gemini-flash-1.5", "Gemini Flash 1.5 (via OpenRouter)", { contextWindow: 1000000, vision: true, speed: "fast", cost: "low" }),
  // DeepSeek
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", { speed: "powerful", cost: "low" }),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", { speed: "fast", cost: "low" }),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", { speed: "balanced", cost: "low" }),
  model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { speed: "powerful", cost: "low" }),
  // Ollama (local)
  model("ollama", "llama3.1", "Llama 3.1 (local)", { contextWindow: 128000, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "qwen2.5", "Qwen 2.5 (local)", { vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "mistral", "Mistral (local)", { vision: false, speed: "fast", cost: "free", privacy: "local" }),
  model("ollama", "phi3", "Phi-3 (local)", { vision: false, speed: "fast", cost: "free", privacy: "local" }),
];

export function listModels(): ModelInfo[] {
  return BUILT_IN_MODELS;
}

export function getModel(id: string): ModelInfo | undefined {
  return BUILT_IN_MODELS.find((m) => m.id === id);
}

export function listModelsForProvider(providerId: ProviderId): ModelInfo[] {
  return BUILT_IN_MODELS.filter((m) => m.providerId === providerId);
}

function labelFromId(id: string): string {
  return id
    .split(/[\/:_-]+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function inferredModel(providerId: ProviderId, id: string, capabilities?: ProviderCapabilities): ModelInfo {
  return {
    version: 1,
    id,
    providerId,
    label: labelFromId(id),
    contextWindow: null,
    capabilities: {
      streaming: capabilities?.streaming ?? true,
      toolCalls: capabilities?.toolCalls ?? true,
      vision: capabilities?.vision ?? false,
    },
    speedClass: "unknown",
    costClass: providerId === "ollama" ? "free" : "unknown",
    privacy: capabilities?.local ? "local" : "remote",
    builtIn: false,
  };
}

export function getModelForProvider(providerId: ProviderId, id: string, capabilities?: ProviderCapabilities): ModelInfo {
  return BUILT_IN_MODELS.find((m) => m.providerId === providerId && m.id === id) ?? inferredModel(providerId, id, capabilities);
}

export function listModelStatuses(env: ProviderEnv = process.env): ModelStatus[] {
  return listProviderStatuses(env).flatMap((provider) => {
    const seen = new Set<string>();
    const ids = [
      ...(provider.defaultModel ? [provider.defaultModel] : []),
      ...provider.models,
    ].filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return ids.map((id) => ({
      model: getModelForProvider(provider.id, id, provider.capabilities),
      available: provider.available && provider.configured,
    }));
  });
}

export function isModelAvailableForProvider(providerId: ProviderId, modelId: string, env: ProviderEnv = process.env): boolean {
  const status = getProviderStatus(providerId, env);
  if (!status || !status.available || !status.configured) return false;
  if (status.models.includes(modelId) || status.defaultModel === modelId) return true;
  // Generic compatible endpoints often cannot enumerate models. If configured
  // but model-less, an explicit caller-provided id is the only honest option.
  return providerId === "openai-compatible" && status.models.length === 0 && status.defaultModel === null;
}

export function availableModelsForProvider(providerId: ProviderId, env: ProviderEnv = process.env): string[] {
  const status = getProviderStatus(providerId, env);
  if (!status || !status.available || !status.configured) return [];
  return [...new Set([...(status.defaultModel ? [status.defaultModel] : []), ...status.models])];
}
