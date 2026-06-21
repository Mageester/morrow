/**
 * Credential abstraction. Secrets are resolved from the environment on the
 * server only. Nothing in this module returns a secret to any caller that feeds
 * the HTTP/API layer: callers receive `configured` booleans and the credential
 * *host* (never the key, never a full URL with embedded credentials).
 *
 * The only place an API key leaves this module is into a provider adapter
 * constructed server-side to make the upstream request.
 */
export type ProviderEnv = Record<string, string | undefined>;

export interface ApiKeyCredential {
  configured: boolean;
  /** Internal use only — passed directly into a provider adapter. */
  apiKey?: string;
  baseUrl: string;
  endpointType: "default" | "custom";
  /** Host of the effective endpoint with no credentials, safe to display. */
  host: string | null;
}

export interface LocalCredential {
  configured: boolean;
  baseUrl: string;
  endpointType: "default" | "custom";
  host: string | null;
}

/** Extract a bare host:port from a URL. Never includes userinfo, path, or query. */
export function safeHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.host || null;
  } catch {
    return null;
  }
}

export function resolveApiKeyCredential(
  env: ProviderEnv,
  options: { apiKeyEnv: string; fallbackApiKeyEnv?: string; baseUrlEnv: string; defaultBaseUrl: string }
): ApiKeyCredential {
  const apiKey = env[options.apiKeyEnv] || (options.fallbackApiKeyEnv ? env[options.fallbackApiKeyEnv] : undefined);
  const customBase = env[options.baseUrlEnv];
  const baseUrl = customBase || options.defaultBaseUrl;
  return {
    configured: !!apiKey,
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    endpointType: customBase ? "custom" : "default",
    host: safeHost(baseUrl),
  };
}

export function resolveLocalCredential(
  env: ProviderEnv,
  options: { baseUrlEnv: string; defaultBaseUrl: string }
): LocalCredential {
  const customBase = env[options.baseUrlEnv];
  const baseUrl = customBase || options.defaultBaseUrl;
  return {
    // Honest opt-in: we do not claim a local server exists unless the operator
    // has explicitly pointed Morrow at one via the environment.
    configured: !!customBase,
    baseUrl,
    endpointType: customBase ? "custom" : "default",
    host: safeHost(baseUrl),
  };
}

/** Defensive redaction for any string that might be logged. */
export function redactSecrets(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***redacted***")
    .replace(/(x-api-key|x-goog-api-key|authorization)\s*[:=]\s*\S+/gi, "$1: ***redacted***");
}
