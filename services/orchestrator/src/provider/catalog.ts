/**
 * Data-driven catalog of OpenAI-compatible model providers.
 *
 * Every provider in here speaks the OpenAI Chat Completions wire format, so a
 * single adapter (`OpenAiCompatibleProvider`) serves all of them and each entry
 * is pure data: identity, endpoint, env-var names, and where a user gets a key.
 * The registry, the secrets writer, and the connectivity checker all derive
 * their behaviour from this one table, so adding a provider is a single entry
 * rather than four parallel edits that can drift apart.
 *
 * Deliberate honesty constraints:
 *
 *  - **No invented model lists.** Catalog providers ship *no* hardcoded model
 *    ids. Model names change constantly and a stale hardcoded list is worse
 *    than none: it makes Morrow claim a model exists when the endpoint would
 *    404. Models come from the provider's own `GET /models` response via
 *    `testProviderConnectivity` → `installProviderModelDiscoveries`. Until a
 *    provider has been probed, its model list is honestly empty and the user is
 *    asked to pick one.
 *  - **No invented auth.** Every entry here authenticates with an API key sent
 *    as `Authorization: Bearer <key>`, which is what these endpoints actually
 *    document. Providers with a real subscription OAuth flow live in
 *    `oauth-flow.ts` instead; nothing in this file pretends to have one.
 *  - **Base URLs are defaults, not assertions.** Each provider's base URL is
 *    overridable via its `*_BASE_URL` env var, so a regional endpoint, a
 *    workspace-scoped host, or a corporate proxy is always reachable.
 */
import type { ProviderId } from "@morrow/contracts";

export type CatalogCategory = "gateway" | "frontier" | "inference" | "local";

export interface CatalogProvider {
  id: ProviderId;
  label: string;
  /** One factual line about what this endpoint is. No marketing claims. */
  summary: string;
  category: CatalogCategory;
  /** OpenAI-compatible base URL, including any version prefix. */
  defaultBaseUrl: string;
  /** Env var holding the API key. Absent for keyless local servers. */
  apiKeyEnv?: string;
  /** Secondary env var accepted for the key (provider's other documented name). */
  fallbackApiKeyEnv?: string;
  baseUrlEnv: string;
  modelEnv: string;
  contextLimitEnv: string;
  /** Local providers run on the user's own machine and need no key. */
  local?: boolean;
  /** Page where a user creates an API key, shown during setup. */
  keyUrl?: string;
  /** Extra headers this gateway documents (e.g. attribution headers). */
  extraHeaders?: Record<string, string>;
  /** Some gateways reject `stream_options.include_usage`; default true. */
  includeUsage?: boolean;
  /** True when the endpoint documents image input on at least some models. */
  vision?: boolean;
  /** True when the provider offers a no-cost tier without billing details. */
  hasFreeTier?: boolean;
}

/**
 * Catalog entries, ordered roughly by how useful they are to a new user.
 *
 * `openai`, `anthropic`, `gemini`, `openrouter`, `deepseek`, `openai-compatible`
 * and `ollama` are NOT in this table — they predate it and have bespoke
 * descriptors in `registry.ts` (native protocols, OAuth, or special model
 * handling). This table is purely the OpenAI-compatible additions.
 */
export const PROVIDER_CATALOG: CatalogProvider[] = [
  // ── Gateways: one key, many upstream models ───────────────────────────────
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    summary: "Curated model gateway from the OpenCode project, including a free tier.",
    category: "gateway",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_ZEN_API_KEY",
    fallbackApiKeyEnv: "OPENCODE_API_KEY",
    baseUrlEnv: "OPENCODE_ZEN_BASE_URL",
    modelEnv: "OPENCODE_ZEN_MODEL",
    contextLimitEnv: "OPENCODE_ZEN_CONTEXT_LIMIT",
    keyUrl: "https://opencode.ai/auth",
    vision: true,
    hasFreeTier: true,
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    summary: "Vercel's routing gateway across many upstream model providers.",
    category: "gateway",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    fallbackApiKeyEnv: "VERCEL_AI_GATEWAY_API_KEY",
    baseUrlEnv: "VERCEL_AI_GATEWAY_BASE_URL",
    modelEnv: "VERCEL_AI_GATEWAY_MODEL",
    contextLimitEnv: "VERCEL_AI_GATEWAY_CONTEXT_LIMIT",
    keyUrl: "https://vercel.com/dashboard/ai-gateway",
    vision: true,
  },
  {
    id: "github-models",
    label: "GitHub Models",
    summary: "Model inference authenticated with a GitHub personal access token.",
    category: "gateway",
    defaultBaseUrl: "https://models.github.ai/inference",
    // Deliberately NOT falling back to `GITHUB_TOKEN`. That variable is set in
    // virtually every CI runner and dev shell for reasons unrelated to model
    // inference, and honouring it here would silently mark a hosted network
    // provider as "configured" — and make it eligible for routing — for users
    // who never opted into it. Credentials must be provider-specific and
    // intentional.
    apiKeyEnv: "GITHUB_MODELS_TOKEN",
    baseUrlEnv: "GITHUB_MODELS_BASE_URL",
    modelEnv: "GITHUB_MODELS_MODEL",
    contextLimitEnv: "GITHUB_MODELS_CONTEXT_LIMIT",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    vision: true,
    hasFreeTier: true,
  },

  // ── Frontier labs with OpenAI-compatible endpoints ────────────────────────
  {
    id: "xai",
    label: "xAI (Grok)",
    summary: "xAI's Grok models over an OpenAI-compatible endpoint.",
    category: "frontier",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    baseUrlEnv: "XAI_BASE_URL",
    modelEnv: "XAI_MODEL",
    contextLimitEnv: "XAI_CONTEXT_LIMIT",
    keyUrl: "https://console.x.ai",
    vision: true,
  },
  {
    id: "mistral",
    label: "Mistral AI",
    summary: "Mistral's hosted models, including their code-specialised line.",
    category: "frontier",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    baseUrlEnv: "MISTRAL_BASE_URL",
    modelEnv: "MISTRAL_MODEL",
    contextLimitEnv: "MISTRAL_CONTEXT_LIMIT",
    keyUrl: "https://console.mistral.ai/api-keys",
    vision: true,
    hasFreeTier: true,
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    summary: "Moonshot's Kimi models over an OpenAI-compatible endpoint.",
    category: "frontier",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    modelEnv: "MOONSHOT_MODEL",
    contextLimitEnv: "MOONSHOT_CONTEXT_LIMIT",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    vision: true,
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    summary: "Z.ai's GLM model family over an OpenAI-compatible endpoint.",
    category: "frontier",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    fallbackApiKeyEnv: "GLM_API_KEY",
    baseUrlEnv: "ZAI_BASE_URL",
    modelEnv: "ZAI_MODEL",
    contextLimitEnv: "ZAI_CONTEXT_LIMIT",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    vision: true,
  },
  {
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    summary: "Qwen models via Alibaba Model Studio's OpenAI-compatible mode.",
    category: "frontier",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    modelEnv: "DASHSCOPE_MODEL",
    contextLimitEnv: "DASHSCOPE_CONTEXT_LIMIT",
    keyUrl: "https://modelstudio.console.alibabacloud.com",
    vision: true,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    summary: "Perplexity's search-grounded models over an OpenAI-compatible endpoint.",
    category: "frontier",
    defaultBaseUrl: "https://api.perplexity.ai",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    baseUrlEnv: "PERPLEXITY_BASE_URL",
    modelEnv: "PERPLEXITY_MODEL",
    contextLimitEnv: "PERPLEXITY_CONTEXT_LIMIT",
    keyUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "cohere",
    label: "Cohere",
    summary: "Cohere's Command models over their OpenAI-compatible endpoint.",
    category: "frontier",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: "COHERE_API_KEY",
    baseUrlEnv: "COHERE_BASE_URL",
    modelEnv: "COHERE_MODEL",
    contextLimitEnv: "COHERE_CONTEXT_LIMIT",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    hasFreeTier: true,
  },

  // ── Inference hosts: open-weight models on fast hardware ──────────────────
  {
    id: "groq",
    label: "Groq",
    summary: "Open-weight models on Groq's LPU inference hardware.",
    category: "inference",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    baseUrlEnv: "GROQ_BASE_URL",
    modelEnv: "GROQ_MODEL",
    contextLimitEnv: "GROQ_CONTEXT_LIMIT",
    keyUrl: "https://console.groq.com/keys",
    hasFreeTier: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    summary: "Open-weight models on Cerebras wafer-scale inference.",
    category: "inference",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    baseUrlEnv: "CEREBRAS_BASE_URL",
    modelEnv: "CEREBRAS_MODEL",
    contextLimitEnv: "CEREBRAS_CONTEXT_LIMIT",
    keyUrl: "https://cloud.cerebras.ai",
    hasFreeTier: true,
  },
  {
    id: "together",
    label: "Together AI",
    summary: "A broad catalog of open-weight models on shared inference.",
    category: "inference",
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    baseUrlEnv: "TOGETHER_BASE_URL",
    modelEnv: "TOGETHER_MODEL",
    contextLimitEnv: "TOGETHER_CONTEXT_LIMIT",
    keyUrl: "https://api.together.xyz/settings/api-keys",
    vision: true,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    summary: "Open-weight and fine-tuned models on Fireworks inference.",
    category: "inference",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    baseUrlEnv: "FIREWORKS_BASE_URL",
    modelEnv: "FIREWORKS_MODEL",
    contextLimitEnv: "FIREWORKS_CONTEXT_LIMIT",
    keyUrl: "https://fireworks.ai/account/api-keys",
    vision: true,
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    summary: "Open-weight models billed per token on DeepInfra.",
    category: "inference",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    baseUrlEnv: "DEEPINFRA_BASE_URL",
    modelEnv: "DEEPINFRA_MODEL",
    contextLimitEnv: "DEEPINFRA_CONTEXT_LIMIT",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    vision: true,
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    summary: "Open-weight models hosted by Nebius.",
    category: "inference",
    defaultBaseUrl: "https://api.studio.nebius.com/v1",
    apiKeyEnv: "NEBIUS_API_KEY",
    baseUrlEnv: "NEBIUS_BASE_URL",
    modelEnv: "NEBIUS_MODEL",
    contextLimitEnv: "NEBIUS_CONTEXT_LIMIT",
    keyUrl: "https://studio.nebius.com/settings/api-keys",
  },
  {
    id: "novita",
    label: "Novita AI",
    summary: "Open-weight models hosted by Novita.",
    category: "inference",
    defaultBaseUrl: "https://api.novita.ai/v3/openai",
    apiKeyEnv: "NOVITA_API_KEY",
    baseUrlEnv: "NOVITA_BASE_URL",
    modelEnv: "NOVITA_MODEL",
    contextLimitEnv: "NOVITA_CONTEXT_LIMIT",
    keyUrl: "https://novita.ai/settings/key-management",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    summary: "Open-weight models on Hyperbolic's inference marketplace.",
    category: "inference",
    defaultBaseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: "HYPERBOLIC_API_KEY",
    baseUrlEnv: "HYPERBOLIC_BASE_URL",
    modelEnv: "HYPERBOLIC_MODEL",
    contextLimitEnv: "HYPERBOLIC_CONTEXT_LIMIT",
    keyUrl: "https://app.hyperbolic.xyz/settings",
  },
  {
    id: "sambanova",
    label: "SambaNova Cloud",
    summary: "Open-weight models on SambaNova's inference hardware.",
    category: "inference",
    defaultBaseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: "SAMBANOVA_API_KEY",
    baseUrlEnv: "SAMBANOVA_BASE_URL",
    modelEnv: "SAMBANOVA_MODEL",
    contextLimitEnv: "SAMBANOVA_CONTEXT_LIMIT",
    keyUrl: "https://cloud.sambanova.ai/apis",
    hasFreeTier: true,
  },

  // ── Local servers: no key, nothing leaves the machine ─────────────────────
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    summary: "Local inference through LM Studio's OpenAI-compatible server.",
    category: "local",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    baseUrlEnv: "LMSTUDIO_BASE_URL",
    modelEnv: "LMSTUDIO_MODEL",
    contextLimitEnv: "LMSTUDIO_CONTEXT_LIMIT",
    local: true,
    includeUsage: false,
  },
  {
    id: "llamacpp",
    label: "llama.cpp (local)",
    summary: "Local inference through a llama.cpp server.",
    category: "local",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    baseUrlEnv: "LLAMACPP_BASE_URL",
    modelEnv: "LLAMACPP_MODEL",
    contextLimitEnv: "LLAMACPP_CONTEXT_LIMIT",
    local: true,
    includeUsage: false,
  },
  {
    id: "vllm",
    label: "vLLM (local or self-hosted)",
    summary: "Inference through a vLLM OpenAI-compatible server you run.",
    category: "local",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    apiKeyEnv: "VLLM_API_KEY",
    baseUrlEnv: "VLLM_BASE_URL",
    modelEnv: "VLLM_MODEL",
    contextLimitEnv: "VLLM_CONTEXT_LIMIT",
    local: true,
    includeUsage: false,
  },
  {
    id: "jan",
    label: "Jan (local)",
    summary: "Local inference through the Jan desktop app's server.",
    category: "local",
    defaultBaseUrl: "http://127.0.0.1:1337/v1",
    baseUrlEnv: "JAN_BASE_URL",
    modelEnv: "JAN_MODEL",
    contextLimitEnv: "JAN_CONTEXT_LIMIT",
    local: true,
    includeUsage: false,
  },
];

const CATALOG_BY_ID = new Map<ProviderId, CatalogProvider>(PROVIDER_CATALOG.map((p) => [p.id, p]));

export function catalogProvider(id: ProviderId): CatalogProvider | undefined {
  return CATALOG_BY_ID.get(id);
}

export function isCatalogProvider(id: ProviderId): boolean {
  return CATALOG_BY_ID.has(id);
}

export const CATALOG_PROVIDER_IDS: ProviderId[] = PROVIDER_CATALOG.map((p) => p.id);

/**
 * Human-readable setup hint. Local servers are opt-in by URL; hosted providers
 * need a key. The text names the exact env var so a headless operator can
 * configure without reading the docs.
 */
export function catalogSetupHint(provider: CatalogProvider): string {
  if (provider.local) {
    return `Start ${provider.label.replace(/ \(.*\)$/, "")} and set ${provider.baseUrlEnv} (default ${provider.defaultBaseUrl}). Optionally set ${provider.modelEnv}.`;
  }
  const key = provider.keyUrl ? ` Get a key at ${provider.keyUrl}.` : "";
  return `Set ${provider.apiKeyEnv}.${key} Optionally set ${provider.modelEnv} and ${provider.baseUrlEnv}.`;
}
