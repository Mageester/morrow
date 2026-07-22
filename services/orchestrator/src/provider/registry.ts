import type { ProviderAuthMode, ProviderId, ProviderStatus, ProviderCapabilities, ProviderKind } from "@morrow/contracts";
import { AiProvider, ProviderError, type ProviderProtocol, type ProviderRouteMetadata } from "./base.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { CodexProvider } from "./codex.js";
import { GeminiProvider } from "./gemini.js";
import {
  ProviderEnv,
  resolveApiKeyCredential,
  resolveLocalCredential,
  safeHost,
} from "./credentials.js";
import { providerCredentialIdentity, providerEnvMapping } from "./secrets.js";
import { getStoredAccessTokenSync } from "./oauth-flow.js";
import { createHash } from "node:crypto";
import type { ProviderModelDiscovery } from "../repositories/provider-model-discovery.js";
import { OPENROUTER_API_BASE_URL } from "./connectivity.js";

let modelDiscoveries: ProviderModelDiscovery[] = [];

export function installProviderModelDiscoveries(discoveries: ProviderModelDiscovery[]): void {
  modelDiscoveries = discoveries.map((item) => ({ ...item, models: [...item.models] }));
}

function withDiscovery(status: ProviderStatus, env: ProviderEnv): ProviderStatus {
  const authMode = status.authMode ?? "unknown";
  const discovery = modelDiscoveries.find((item) => item.providerId === status.id && item.authMode === authMode);
  if (status.id === "openrouter" && discovery && discovery.credentialIdentity !== providerCredentialIdentity(status.id, env)) {
    return { ...status, configured: false, available: false, authStatus: "unavailable" };
  }
  if (!discovery) return status.id === "openrouter" && status.configured
    ? { ...status, configured: false, available: false, authStatus: "unavailable" }
    : status;
  const discoveredModels = discovery.models.map((model) => model.providerModelId);
  const withDiscoveredModels: ProviderStatus = {
    ...status,
    models: status.defaultModel && !discoveredModels.includes(status.defaultModel)
      ? [status.defaultModel, ...discoveredModels]
      : discoveredModels,
    defaultModel: status.defaultModel,
    lastSuccessAt: discovery.lastSuccessAt ?? null,
  };
  if (status.id === "openrouter" && (!discovery.expiresAt || Date.parse(discovery.expiresAt) <= Date.now())) {
    return { ...withDiscoveredModels, configured: false, available: false, authStatus: "unavailable" };
  }
  if (discovery.status === "unavailable") return status.id === "openrouter"
    ? { ...withDiscoveredModels, configured: false, available: false, authStatus: "unavailable" }
    : { ...status, available: false };
  if (discoveredModels.length === 0) return { ...status, available: true };
  return {
    ...withDiscoveredModels,
    available: true,
  };
}

/** Mark a status as configured/available because a subscription OAuth token is held. */
function withOAuth(status: ProviderStatus, authMode: ProviderAuthMode): ProviderStatus {
  return { ...status, configured: true, available: true, authStatus: "configured", authMode };
}

function apiKeyAuthMode(id: ProviderId): ProviderAuthMode {
  return ({
    openai: "openai-api-key",
    anthropic: "anthropic-api-key",
    gemini: "gemini-api-key",
    openrouter: "openrouter-api-key",
    deepseek: "deepseek-api-key",
  } as Partial<Record<ProviderId, ProviderAuthMode>>)[id] ?? "unknown";
}

/** Persisted default-model override for a provider, if the operator set one. */
function modelOverride(env: ProviderEnv, id: ProviderId): string | undefined {
  const modelEnv = providerEnvMapping(id)?.modelEnv;
  const value = modelEnv ? env[modelEnv] : undefined;
  return value && value.trim() ? value.trim() : undefined;
}

/** Resolve the effective model: explicit override → persisted default → built-in. */
function resolveModel(env: ProviderEnv, id: ProviderId, explicit: string | undefined, fallback: string): string {
  return explicit || modelOverride(env, id) || fallback;
}

function configuredContextLimit(env: ProviderEnv, id: ProviderId): number | null {
  const name = providerEnvMapping(id)?.contextLimitEnv;
  const raw = name ? env[name] : undefined;
  if (!raw?.trim()) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderError("invalid_context_limit", `${name} must be a positive safe integer`, { kind: "invalid_request" });
  }
  return value;
}

function routeMetadata(input: {
  env: ProviderEnv;
  id: ProviderId;
  protocol: ProviderProtocol;
  endpointKind: "default" | "custom" | "injected";
  endpointHost: string | null;
  defaultEndpointLimitTokens?: number;
}): ProviderRouteMetadata {
  const override = configuredContextLimit(input.env, input.id);
  const providerLimit = input.endpointKind === "default" ? input.defaultEndpointLimitTokens ?? null : null;
  const configuredBaseUrlName = providerEnvMapping(input.id)?.baseUrlEnv;
  const configuredBaseUrl = configuredBaseUrlName ? input.env[configuredBaseUrlName]?.trim() : undefined;
  const routeIdentity = configuredBaseUrl || `${input.protocol}:${input.endpointKind}:${input.endpointHost ?? "unknown"}`;
  return {
    providerId: input.id,
    protocol: input.protocol,
    endpointKind: input.endpointKind,
    endpointHost: input.endpointHost,
    endpointIdentityHash: createHash("sha256").update(routeIdentity.replace(/\/+$/, "")).digest("hex"),
    endpointLimitTokens: override ?? providerLimit,
    endpointLimitSource: override !== null
      ? "endpoint-override"
      : providerLimit !== null
        ? "provider-metadata"
        : "unknown",
  };
}

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
  cred: { configured: boolean; endpointType: "default" | "custom"; host: string | null },
  env: ProviderEnv
): ProviderStatus {
  const override = modelOverride(env, d.id);
  const defaultModel = override || d.defaultModel || null;
  const models = override && !d.models.includes(override) ? [override, ...d.models] : d.models;
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
    authMode: apiKeyAuthMode(d.id),
    capabilities: d.capabilities,
    models,
    defaultModel,
    note: d.note,
    setupHint: d.setupHint,
  };
}

const DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: false }),
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    setupHint: "Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL for a compatible gateway).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" });
      const s = apiKeyStatus(this, c, env);
      if (getStoredAccessTokenSync("openai", env)) {
        // Subscription sign-in routes through the Codex backend, which serves its
        // own model slugs (gpt-5.x), not the api.openai.com model ids.
        const override = modelOverride(env, "openai");
        return { ...withOAuth(s, "codex-oauth"), defaultModel: override || "gpt-5.5", models: ["gpt-5.5", ...s.models] };
      }
      return s;
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" });
      // A ChatGPT/Codex subscription OAuth token only works against the Codex
      // backend (chatgpt.com/backend-api/codex), not api.openai.com — so route it
      // through the CodexProvider. An API key uses the standard endpoint.
      const oauthToken = getStoredAccessTokenSync("openai", env);
      if (oauthToken) {
        return new CodexProvider({ oauthToken, defaultModel: resolveModel(env, this.id, model, "gpt-5.5"), route: routeMetadata({ env, id: this.id, protocol: "openai-responses", endpointKind: "default", endpointHost: "chatgpt.com" }) });
      }
      if (!c.configured) throw new ProviderError("not_configured", "OpenAI is not configured (sign in with OAuth or set OPENAI_API_KEY)", { kind: "auth" });
      return new OpenAiCompatibleProvider({ id: "openai", apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: resolveModel(env, this.id, model, this.defaultModel), includeUsage: true, route: routeMetadata({ env, id: this.id, protocol: "openai-chat", endpointKind: c.endpointType, endpointHost: c.host }) });
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: true }),
    defaultModel: "claude-opus-4-8",
    models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    setupHint: "Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" });
      const s = apiKeyStatus(this, c, env);
      return getStoredAccessTokenSync("anthropic", env) ? withOAuth(s, "anthropic-oauth") : s;
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" });
      // Prefer a Claude subscription OAuth token when present: the adapter sends
      // it as a Bearer token with the OAuth beta header instead of x-api-key.
      const oauthToken = getStoredAccessTokenSync("anthropic", env);
      if (!oauthToken && !c.configured) throw new ProviderError("not_configured", "Anthropic is not configured (sign in with OAuth or set ANTHROPIC_API_KEY)", { kind: "auth" });
      return new AnthropicProvider({
        apiKey: c.apiKey ?? "",
        baseUrl: c.baseUrl,
        defaultModel: resolveModel(env, this.id, model, this.defaultModel),
        ...(oauthToken ? { oauthToken } : {}),
        route: routeMetadata({ env, id: this.id, protocol: "anthropic-messages", endpointKind: c.endpointType, endpointHost: c.host }),
      });
    },
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "api-key",
    capabilities: caps({ vision: true }),
    defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    setupHint: "Set GEMINI_API_KEY (or GOOGLE_API_KEY).",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "GEMINI_API_KEY", fallbackApiKeyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com" });
      return apiKeyStatus(this, c, env);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "GEMINI_API_KEY", fallbackApiKeyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com" });
      if (!c.configured) throw new ProviderError("not_configured", "Gemini is not configured (GEMINI_API_KEY missing)", { kind: "auth" });
      return new GeminiProvider({ apiKey: c.apiKey!, baseUrl: c.baseUrl, defaultModel: resolveModel(env, this.id, model, this.defaultModel), route: routeMetadata({ env, id: this.id, protocol: "gemini-generate-content", endpointKind: c.endpointType, endpointHost: c.host }) });
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "api-key",
    capabilities: caps({ vision: true, customEndpoint: false }),
    defaultModel: "openrouter/auto",
    models: ["openrouter/auto", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
    setupHint: "Set OPENROUTER_API_KEY.",
    note: "Aggregates many upstream models behind one OpenAI-compatible endpoint.",
    status(env) {
      const c = { configured: !!env.OPENROUTER_API_KEY?.trim(), endpointType: "default" as const, host: "openrouter.ai" };
      return apiKeyStatus(this, c, env);
    },
    build(env, model) {
      const apiKey = env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) throw new ProviderError("not_configured", "OpenRouter is not configured (OPENROUTER_API_KEY missing)", { kind: "auth" });
      return new OpenAiCompatibleProvider({
        id: "openrouter",
        apiKey,
        baseUrl: OPENROUTER_API_BASE_URL,
        defaultModel: resolveModel(env, this.id, model, this.defaultModel),
        includeUsage: true,
        extraHeaders: { "HTTP-Referer": "https://morrow.local", "X-Title": "Morrow" },
        route: routeMetadata({ env, id: this.id, protocol: "openai-chat", endpointKind: "default", endpointHost: "openrouter.ai" }),
      });
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "api-key",
    capabilities: caps({ customEndpoint: true }),
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    setupHint: "Set DEEPSEEK_API_KEY.",
    note: null,
    status(env) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com/v1" });
      return apiKeyStatus(this, c, env);
    },
    build(env, model) {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com/v1" });
      if (!c.configured) throw new ProviderError("not_configured", "DeepSeek is not configured (DEEPSEEK_API_KEY missing)", { kind: "auth" });
      return new OpenAiCompatibleProvider({
        id: "deepseek",
        apiKey: c.apiKey!,
        baseUrl: c.baseUrl,
        defaultModel: resolveModel(env, this.id, model, this.defaultModel),
        includeUsage: true,
        route: routeMetadata({
          env,
          id: this.id,
          protocol: "openai-chat",
          endpointKind: c.endpointType,
          endpointHost: c.host,
          defaultEndpointLimitTokens: 131_072,
        }),
      });
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
        authMode: safeHost(baseUrl) === "opencode.ai" ? "opencode-zen" : "custom-compatible",
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
      cfg.route = routeMetadata({ env, id: this.id, protocol: "openai-chat", endpointKind: "custom", endpointHost: safeHost(baseUrl) });
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
        authMode: "ollama",
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
      return new OpenAiCompatibleProvider({ id: "ollama", baseUrl: c.baseUrl, defaultModel: model || env.OLLAMA_MODEL || this.defaultModel, includeUsage: false, route: routeMetadata({ env, id: this.id, protocol: "openai-chat", endpointKind: c.endpointType, endpointHost: c.host }) });
    },
  },
];

const BY_ID = new Map<ProviderId, ProviderDescriptor>(DESCRIPTORS.map((d) => [d.id, d]));

export function listProviderStatuses(env: ProviderEnv = process.env): ProviderStatus[] {
  const statuses = DESCRIPTORS.map((d) => withDiscovery(d.status(env), env));
  if (env.MOCK_PROVIDER === "true") {
    statuses.push(withDiscovery({
      version: 1,
      id: "mock",
      label: "Mock provider (testing)",
      kind: "mock",
      configured: true,
      available: true,
      endpointType: "default",
      endpointHost: null,
      authStatus: "not-applicable",
      authMode: "mock",
      capabilities: caps({ local: true, vision: false }),
      models: ["mock-model"],
      defaultModel: "mock-model",
      note: "Deterministic in-memory provider. Only present because MOCK_PROVIDER=true.",
      setupHint: "Unset MOCK_PROVIDER to use real providers.",
    }, env));
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
