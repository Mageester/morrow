import type { ProviderId, ProviderStatus, ProviderCapabilities, ProviderKind } from "@morrow/contracts";
import { AiProvider, ProviderError } from "./base.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import {
  ProviderEnv,
  resolveApiKeyCredential,
  resolveLocalCredential,
  safeHost,
} from "./credentials.js";

interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  capabilities: ProviderCapabilities;
  defaultModel: string;
  models: string[];
  setupHint: string;
  note: string | null;
  /** Compute current status from the environment (never exposes secrets). */
  status(env: ProviderEnv): ProviderStatus;
  /** Build a provider instance, or throw a typed error if not configured. */
  build(env: ProviderEnv, model?: string): AiProvider;
}

const caps = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  streaming: true,
  toolCalls: true,
  systemMessages: true,
  vision: false,
  customEndpoint: false,
  local: false,
  ...over,
});

function apiKeyStatus(
  d: Pick<ProviderDescriptor, "id" | "label" | "kind" | "capabilities" | "defaultModel" | "models" | "setupHint" | "note">,
  cred: { configured: boolean; endpointType: "default" | "custom"; host: string | null }
): ProviderStatus {
  return {
    version: 1,
    id: d.id,
    label: d.label,
    kind: d.kind,
    configured: cred.configured,
    available: cred.configured,
    endpointType: cred.endpointType,
    endpointHost: cred.host,
    authStatus: cred.configured ? "configured" : "missing",
    capabilities: d.capabilities,
    models: d.models,
    defaultModel: d.defaultModel || null,
    note: d.note,
    setupHint: d.setupHint,
  };
}

const DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: true }),
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    setupHint: "Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL for a compatible gateway).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" });
      return apiKeyStatus(this, c);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" });
      if (!c.configured) throw new ProviderError("not_configured", "OpenAI is not configured (OPENAI_API_KEY missing)", { kind: "auth" });
      return new OpenAiCompatibleProvider({ id: "openai", apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: model || this.defaultModel, includeUsage: true });
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: true }),
    defaultModel: "claude-3-5-sonnet-20241022",
    models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
    setupHint: "Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" });
      return apiKeyStatus(this, c);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" });
      if (!c.configured) throw new ProviderError("not_configured", "Anthropic is not configured (ANTHROPIC_API_KEY missing)", { kind: "auth" });
      return new AnthropicProvider({ apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: model || this.defaultModel });
    },
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "api-key",
    capabilities: caps({ vision: true }),
    defaultModel: "gemini-1.5-flash",
    models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
    setupHint: "Set GEMINI_API_KEY (or GOOGLE_API_KEY).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "GEMINI_API_KEY", fallbackApiKeyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com" });
      return apiKeyStatus(this, c);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "GEMINI_API_KEY", fallbackApiKeyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com" });
      if (!c.configured) throw new ProviderError("not_configured", "Gemini is not configured (GEMINI_API_KEY missing)", { kind: "auth" });
      return new GeminiProvider({ apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: model || this.defaultModel });
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: true }),
    defaultModel: "openrouter/auto",
    models: ["openrouter/auto", "anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-flash-1.5"],
    setupHint: "Set OPENROUTER_API_KEY.",
    note: "Aggregates many upstream models behind one OpenAI-compatible endpoint.",
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", defaultBaseUrl: "https://openrouter.ai/api/v1" });
      return apiKeyStatus(this, c);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", defaultBaseUrl: "https://openrouter.ai/api/v1" });
      if (!c.configured) throw new ProviderError("not_configured", "OpenRouter is not configured (OPENROUTER_API_KEY missing)", { kind: "auth" });
      return new OpenAiCompatibleProvider({
        id: "openrouter",
        apiKey: c.apiKey!,
        baseUrl: c.baseUrl,
        defaultModel: model || this.defaultModel,
        includeUsage: true,
        extraHeaders: { "HTTP-Referer": "https://morrow.local", "X-Title": "Morrow" },
      });
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "api-key",
    capabilities: caps({ customEndpoint: true }),
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    setupHint: "Set DEEPSEEK_API_KEY.",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com/v1" });
      return apiKeyStatus(this, c);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com/v1" });
      if (!c.configured) throw new ProviderError("not_configured", "DeepSeek is not configured (DEEPSEEK_API_KEY missing)", { kind: "auth" });
      return new OpenAiCompatibleProvider({ id: "deepseek", apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: model || this.defaultModel, includeUsage: true });
    },
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    kind: "api-key",
    capabilities: caps({ customEndpoint: true }),
    defaultModel: "",
    models: [],
    setupHint: "Set OPENAI_COMPAT_BASE_URL (and OPENAI_COMPAT_API_KEY if the gateway requires it). Optionally OPENAI_COMPAT_MODEL.",
    note: "Generic adapter for any self-hosted or third-party OpenAI-compatible gateway.",
    status(env) {
      const baseUrl = env.OPENAI_COMPAT_BASE_URL;
      const hasKey = !!env.OPENAI_COMPAT_API_KEY;
      const configured = !!baseUrl;
      const model = env.OPENAI_COMPAT_MODEL || "";
      return {
        version: 1,
        id: this.id,
        label: this.label,
        kind: this.kind,
        configured,
        available: configured,
        endpointType: "custom",
        endpointHost: safeHost(baseUrl),
        authStatus: configured ? (hasKey ? "configured" : "not-applicable") : "missing",
        capabilities: this.capabilities,
        models: model ? [model] : [],
        defaultModel: model || null,
        note: this.note,
        setupHint: this.setupHint,
      };
    },
    build(env, model) {
      const baseUrl = env.OPENAI_COMPAT_BASE_URL;
      if (!baseUrl) throw new ProviderError("not_configured", "OpenAI-compatible endpoint is not configured (OPENAI_COMPAT_BASE_URL missing)", { kind: "invalid_request" });
      const resolvedModel = model || env.OPENAI_COMPAT_MODEL || "";
      if (!resolvedModel) throw new ProviderError("not_configured", "OpenAI-compatible endpoint requires a model (set OPENAI_COMPAT_MODEL or pass an override)", { kind: "invalid_request" });
      const cfg: any = { id: "openai-compatible", baseUrl, defaultModel: resolvedModel, includeUsage: true };
      if (env.OPENAI_COMPAT_API_KEY) cfg.apiKey = env.OPENAI_COMPAT_API_KEY;
      return new OpenAiCompatibleProvider(cfg);
    },
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "local",
    capabilities: caps({ local: true, customEndpoint: true }),
    defaultModel: "llama3.1",
    models: ["llama3.1", "qwen2.5", "mistral", "phi3"],
    setupHint: "Run Ollama locally and set OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 to enable. Optionally OLLAMA_MODEL.",
    note: "Fully local inference. No data leaves the machine; no API key required.",
    status(env) {
      const c = resolveLocalCredential(env, { baseUrlEnv: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434/v1" });
      const model = env.OLLAMA_MODEL || this.defaultModel;
      return {
        version: 1,
        id: this.id,
        label: this.label,
        kind: this.kind,
        configured: c.configured,
        available: c.configured,
        endpointType: c.endpointType,
        endpointHost: c.host,
        authStatus: "not-applicable",
        capabilities: this.capabilities,
        models: env.OLLAMA_MODELS ? env.OLLAMA_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : this.models,
        defaultModel: model,
        note: this.note,
        setupHint: this.setupHint,
      };
    },
    build(env, model) {
      const c = resolveLocalCredential(env, { baseUrlEnv: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434/v1" });
      if (!c.configured) throw new ProviderError("not_configured", "Ollama is not enabled (set OLLAMA_BASE_URL to a running server)", { kind: "invalid_request" });
      return new OpenAiCompatibleProvider({ id: "ollama", baseUrl: c.baseUrl, defaultModel: model || env.OLLAMA_MODEL || this.defaultModel, includeUsage: false });
    },
  },
];

const BY_ID = new Map<ProviderId, ProviderDescriptor>(DESCRIPTORS.map((d) => [d.id, d]));

export function listProviderStatuses(env: ProviderEnv = process.env): ProviderStatus[] {
  const statuses = DESCRIPTORS.map((d) => d.status(env));
  if (env.MOCK_PROVIDER === "true") {
    statuses.push({
      version: 1,
      id: "mock",
      label: "Mock provider (testing)",
      kind: "mock",
      configured: true,
      available: true,
      endpointType: "default",
      endpointHost: null,
      authStatus: "not-applicable",
      capabilities: caps({ local: true, vision: false }),
      models: ["mock-model"],
      defaultModel: "mock-model",
      note: "Deterministic in-memory provider. Only present because MOCK_PROVIDER=true.",
      setupHint: "Unset MOCK_PROVIDER to use real providers.",
    });
  }
  return statuses;
}

export function getProviderStatus(id: ProviderId, env: ProviderEnv = process.env): ProviderStatus | undefined {
  return listProviderStatuses(env).find((s) => s.id === id);
}

export function isProviderConfigured(id: ProviderId, env: ProviderEnv = process.env): boolean {
  return getProviderStatus(id, env)?.configured ?? false;
}

export function getProviderDefaultModel(id: ProviderId, env: ProviderEnv = process.env): string | null {
  return getProviderStatus(id, env)?.defaultModel ?? null;
}

export function createProvider(id: ProviderId, env: ProviderEnv = process.env, model?: string): AiProvider {
  const descriptor = BY_ID.get(id);
  if (!descriptor) throw new ProviderError("unknown_provider", `Unknown provider: ${id}`, { kind: "invalid_request" });
  return descriptor.build(env, model);
}

export function providerCapabilities(id: ProviderId): ProviderCapabilities | undefined {
  return BY_ID.get(id)?.capabilities;
}

export const PROVIDER_IDS: ProviderId[] = DESCRIPTORS.map((d) => d.id);
