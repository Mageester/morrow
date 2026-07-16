import type { ModelAuthMode, ProviderId, ProviderTestResult } from "@morrow/contracts";
import { classifyHttpStatus, classifyThrownError } from "./base.js";
import { resolveApiKeyCredential, resolveLocalCredential, type ProviderEnv } from "./credentials.js";
import { getStoredAccessTokenSync } from "./oauth-flow.js";
import { codexHeaders } from "./codex.js";

/**
 * Bounded, server-side provider connectivity check. Performs a single, cheap,
 * read-only request (a model/list lookup) to confirm credentials and reachability.
 *
 * Security invariants:
 *  - Runs only on the server; the API key never leaves this process.
 *  - The result never contains the key, the Authorization header, or a URL with
 *    embedded credentials — only the bare host of the checked endpoint.
 *  - The request is time-bounded and reads at most a small JSON body.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      /* best effort cancellation */
    }
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function modelIds(json: unknown): string[] {
  try {
    const anyJson = json as any;
    // OpenAI-style: { data: [{ id }] }
    if (Array.isArray(anyJson?.data)) {
      return anyJson.data.map((m: any) => m?.id).filter((x: unknown) => typeof x === "string");
    }
    // Anthropic: { data: [{ id }] } (covered above). Gemini: { models: [{ name }] }
    if (Array.isArray(anyJson?.models)) {
      return anyJson.models
        .map((m: any) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : m?.id))
        .filter((x: unknown) => typeof x === "string")
    }
  } catch {
    /* ignore shape errors — sampling is best-effort */
  }
  return [];
}

function sampleModels(json: unknown): string[] {
  return modelIds(json).slice(0, 5);
}

interface PlannedRequest {
  url: string;
  headers: Record<string, string>;
  host: string | null;
}

export interface DiscoveredProviderModel {
  providerId: ProviderId;
  authMode: ModelAuthMode;
  providerModelId: string;
  discoveredAt: string;
}

const discoveryCache = new Map<string, { expiresAt: number; models: DiscoveredProviderModel[] }>();
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

function planRequest(id: ProviderId, env: ProviderEnv): { configured: boolean; request?: PlannedRequest; reason?: string } {
  switch (id) {
    case "openai":
    case "openrouter":
    case "deepseek": {
      const cfgByProvider: Record<string, { apiKeyEnv: string; baseUrlEnv: string; defaultBaseUrl: string; extra?: Record<string, string> }> = {
        openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" },
        openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", defaultBaseUrl: "https://openrouter.ai/api/v1", extra: { "HTTP-Referer": "https://morrow.local", "X-Title": "Morrow" } },
        deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com/v1" },
      };
      const spec = cfgByProvider[id]!;
      const c = resolveApiKeyCredential(env, { apiKeyEnv: spec.apiKeyEnv, baseUrlEnv: spec.baseUrlEnv, defaultBaseUrl: spec.defaultBaseUrl });
      // A ChatGPT/Codex subscription OAuth token (OpenAI only) must be checked
      // against the Codex backend with its Cloudflare-safe headers — probing
      // api.openai.com with it returns 403/401.
      const oauthToken = id === "openai" ? getStoredAccessTokenSync("openai", env) : null;
      if (oauthToken) {
        return { configured: true, request: { url: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", headers: codexHeaders(oauthToken), host: "chatgpt.com" } };
      }
      if (!c.apiKey) return { configured: false, reason: `${id} is not configured (${spec.apiKeyEnv} missing).` };
      return { configured: true, request: { url: `${c.baseUrl.replace(/\/$/, "")}/models`, headers: { Authorization: `Bearer ${c.apiKey}`, ...(spec.extra ?? {}) }, host: c.host } };
    }
    case "anthropic": {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" });
      const oauthToken = getStoredAccessTokenSync("anthropic", env);
      if (oauthToken) {
        // Subscription transport: Bearer + OAuth beta header, no x-api-key.
        return { configured: true, request: { url: `${c.baseUrl.replace(/\/$/, "")}/v1/models`, headers: { Authorization: `Bearer ${oauthToken}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }, host: c.host } };
      }
      if (!c.configured) return { configured: false, reason: "anthropic is not configured (ANTHROPIC_API_KEY missing)." };
      return { configured: true, request: { url: `${c.baseUrl.replace(/\/$/, "")}/v1/models`, headers: { "x-api-key": c.apiKey!, "anthropic-version": "2023-06-01" }, host: c.host } };
    }
    case "gemini": {
      const c = resolveApiKeyCredential(env, { apiKeyEnv: "GEMINI_API_KEY", fallbackApiKeyEnv: "GOOGLE_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com" });
      if (!c.configured) return { configured: false, reason: "gemini is not configured (GEMINI_API_KEY missing)." };
      // Key passed as query param per the documented Generative Language API.
      return { configured: true, request: { url: `${c.baseUrl.replace(/\/$/, "")}/v1beta/models?key=${encodeURIComponent(c.apiKey!)}`, headers: {}, host: c.host } };
    }
    case "openai-compatible": {
      const baseUrl = env.OPENAI_COMPAT_BASE_URL;
      if (!baseUrl) return { configured: false, reason: "openai-compatible endpoint is not configured (OPENAI_COMPAT_BASE_URL missing)." };
      const headers: Record<string, string> = {};
      if (env.OPENAI_COMPAT_API_KEY) headers.Authorization = `Bearer ${env.OPENAI_COMPAT_API_KEY}`;
      return { configured: true, request: { url: `${baseUrl.replace(/\/$/, "")}/models`, headers, host: safeHostOf(baseUrl) } };
    }
    case "ollama": {
      const c = resolveLocalCredential(env, { baseUrlEnv: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434/v1" });
      if (!c.configured) return { configured: false, reason: "ollama is not enabled (set OLLAMA_BASE_URL to a running server)." };
      return { configured: true, request: { url: `${c.baseUrl.replace(/\/$/, "")}/models`, headers: {}, host: c.host } };
    }
    case "mock":
    case "deterministic-local":
      return { configured: true };
    default:
      return { configured: false, reason: `Unknown provider: ${id}` };
  }
}

/**
 * Return model IDs exposed by the exact authenticated provider surface. The
 * result deliberately carries no credentials or endpoint URL and is cached in
 * memory only. A failed discovery returns no assertion of availability.
 */
export async function discoverProviderModels(id: ProviderId, env: ProviderEnv = process.env, timeoutMs = 1500): Promise<DiscoveredProviderModel[]> {
  const plan = planRequest(id, env);
  if (!plan.configured || !plan.request) return [];
  const authMode: ModelAuthMode = id === "openai" && getStoredAccessTokenSync("openai", env)
    ? "codex-oauth"
    : id === "ollama" ? "local"
      : id === "openai-compatible" ? "custom"
        : "api-key";
  const cacheKey = `${id}:${authMode}:${plan.request.host ?? "unknown"}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(plan.request.url, { method: "GET", headers: plan.request.headers, signal: controller.signal });
    const body = await readBoundedJson(response);
    if (!response.ok) return [];
    const discoveredAt = new Date().toISOString();
    const models = [...new Set(modelIds(body))].map((providerModelId) => ({ providerId: id, authMode, providerModelId, discoveredAt }));
    discoveryCache.set(cacheKey, { expiresAt: Date.now() + DISCOVERY_TTL_MS, models });
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function safeHostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export async function testProviderConnectivity(
  id: ProviderId,
  env: ProviderEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProviderTestResult> {
  const base: ProviderTestResult = {
    id,
    ok: false,
    configured: false,
    status: null,
    latencyMs: null,
    checkedEndpoint: null,
    detail: "",
    errorKind: null,
    modelsSample: [],
  };

  const plan = planRequest(id, env);
  if (!plan.configured) {
    return { ...base, configured: false, detail: plan.reason ?? "Not configured." };
  }
  if (!plan.request) {
    // Local/mock providers that require no network.
    return { ...base, configured: true, ok: true, detail: "No network check required for this provider." };
  }

  const { url, headers, host } = plan.request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    const body = await readBoundedJson(res);
    if (res.ok) {
      return { ...base, configured: true, ok: true, status: res.status, latencyMs, checkedEndpoint: host, detail: `Reachable (HTTP ${res.status}).`, modelsSample: sampleModels(body) };
    }
    const err = classifyHttpStatus(res.status, `HTTP ${res.status}`);
    return { ...base, configured: true, ok: false, status: res.status, latencyMs, checkedEndpoint: host, detail: `Endpoint returned HTTP ${res.status} (${err.kind}).`, errorKind: err.kind };
  } catch (e: any) {
    const aborted = controller.signal.aborted;
    const err = classifyThrownError(e, aborted);
    return { ...base, configured: true, ok: false, latencyMs: Date.now() - startedAt, checkedEndpoint: host, detail: aborted ? `Timed out after ${timeoutMs} ms.` : err.message, errorKind: aborted ? "timeout" : err.kind };
  } finally {
    clearTimeout(timer);
  }
}
