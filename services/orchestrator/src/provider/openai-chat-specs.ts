import type { ProviderId } from "@morrow/contracts";

/**
 * Single source of truth for every key-authenticated provider that speaks the
 * plain OpenAI chat-completions protocol. The registry builds descriptors from
 * these specs and the connectivity prober plans its /models request from the
 * same entry, so adding a provider here is the complete server-side wiring —
 * no parallel per-provider switch arms to keep in sync.
 *
 * Env-var names (API key / base URL / model / context limit) come from
 * PROVIDER_ENV in secrets.ts, which remains the canonical env mapping.
 */
export interface OpenAiChatKeySpec {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  setupHint: string;
  note: string | null;
  /** Provider-level vision support (model-level truth lives in the catalog). */
  vision?: boolean;
  /** False for providers whose chat API cannot drive tools (e.g. Perplexity). */
  toolCalls?: boolean;
  /** Secondary env var also accepted for the API key (e.g. DASHSCOPE_API_KEY). */
  fallbackApiKeyEnv?: string;
  /** Extra static headers the endpoint expects. */
  extraHeaders?: Record<string, string>;
  /** Verified default-endpoint request ceiling, when the provider documents one. */
  defaultEndpointLimitTokens?: number;
}

export const OPENAI_CHAT_KEY_SPECS: OpenAiChatKeySpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    models: ["openrouter/auto", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
    setupHint: "Set OPENROUTER_API_KEY.",
    note: "Aggregates many upstream models behind one OpenAI-compatible endpoint.",
    vision: true,
    extraHeaders: { "HTTP-Referer": "https://morrow.local", "X-Title": "Morrow" },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    setupHint: "Set DEEPSEEK_API_KEY.",
    note: null,
    defaultEndpointLimitTokens: 131_072,
  },
  {
    id: "xai",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    models: ["grok-4", "grok-4-fast", "grok-code-fast-1"],
    setupHint: "Set XAI_API_KEY (console.x.ai).",
    note: null,
    vision: true,
  },
  {
    id: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"],
    setupHint: "Set GROQ_API_KEY (console.groq.com).",
    note: "LPU-served open models with very high token throughput.",
  },
  {
    id: "mistral",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: ["mistral-large-latest", "mistral-medium-latest", "codestral-latest", "mistral-small-latest"],
    setupHint: "Set MISTRAL_API_KEY (console.mistral.ai).",
    note: null,
    vision: true,
  },
  {
    id: "together",
    label: "Together AI",
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-Coder-32B-Instruct"],
    setupHint: "Set TOGETHER_API_KEY (api.together.ai).",
    note: "Hosts a broad catalog of open-weights models.",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/qwen2p5-coder-32b-instruct",
    ],
    setupHint: "Set FIREWORKS_API_KEY (fireworks.ai).",
    note: "Hosts a broad catalog of open-weights models.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    models: ["llama-3.3-70b", "qwen-3-32b", "gpt-oss-120b"],
    setupHint: "Set CEREBRAS_API_KEY (cloud.cerebras.ai).",
    note: "Wafer-scale inference with very high token throughput.",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2-0905-preview",
    models: ["kimi-k2-0905-preview", "kimi-k2-0711-preview"],
    setupHint: "Set MOONSHOT_API_KEY (platform.moonshot.ai).",
    note: null,
  },
  {
    id: "zhipu",
    label: "Z.ai GLM",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-4.6",
    models: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
    setupHint: "Set ZHIPU_API_KEY (z.ai).",
    note: null,
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-coder-plus",
    models: ["qwen3-coder-plus", "qwen3-max", "qwen-plus"],
    setupHint: "Set QWEN_API_KEY (or DASHSCOPE_API_KEY).",
    note: null,
    fallbackApiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar-pro",
    models: ["sonar-pro", "sonar", "sonar-reasoning-pro"],
    setupHint: "Set PERPLEXITY_API_KEY (perplexity.ai/settings/api).",
    note: "Search-grounded answers; the chat API does not support tool calls, so agent missions cannot run on this route.",
    toolCalls: false,
  },
];

export function openAiChatKeySpec(id: ProviderId): OpenAiChatKeySpec | undefined {
  return OPENAI_CHAT_KEY_SPECS.find((spec) => spec.id === id);
}
