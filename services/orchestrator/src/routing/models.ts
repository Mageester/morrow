import type { ModelInfo, ProviderId } from "@morrow/contracts";

/**
 * Built-in known model registry with capability metadata. Model IDs remain
 * configurable: any provider can also be driven with a custom model id passed
 * as an override. Context windows are only asserted where well documented;
 * unknown values are reported as null rather than guessed, so the UI never
 * presents a stale or fabricated capability claim.
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
