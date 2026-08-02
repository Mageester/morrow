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

const BENIGN_ASSIGNMENT_NAMES = new Set(["cache_key", "index_key", "object_key"]);
const BENIGN_AUTHORIZATION_VALUES = new Set(["disabled", "none"]);
const EXPLICIT_SENSITIVE_ASSIGNMENT_NAMES = new Set([
  "access_key",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "client_secret",
  "cookie",
  "jwt",
  "passphrase",
  "password",
  "passwd",
  "private_key",
  "proxy_authorization",
  "refresh_token",
  "secret",
  "secret_key",
  "session",
  "session_token",
  "token",
]);

function normalizedCredentialName(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function unquoted(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return quote && quote === trimmed[trimmed.length - 1] && (quote === "\"" || quote === "'" || quote === "`")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isBenignAuthorizationValue(value: string): boolean {
  return BENIGN_AUTHORIZATION_VALUES.has(unquoted(value).toLowerCase());
}

function redactedValue(value: string): string {
  const quote = value[0];
  return quote && quote === value[value.length - 1] && (quote === "\"" || quote === "'" || quote === "`")
    ? `${quote}***redacted***${quote}`
    : "***redacted***";
}

function isSensitiveAssignmentName(name: string): boolean {
  const normalized = normalizedCredentialName(name);
  if (BENIGN_ASSIGNMENT_NAMES.has(normalized) || normalized === "key") return false;
  return EXPLICIT_SENSITIVE_ASSIGNMENT_NAMES.has(normalized)
    || /(?:_key|_token|_secret|_password|_passwd|_passphrase)$/.test(normalized);
}

/** Defensive redaction for any string that might be logged. */
export function redactSecrets(input: string): string {
  return input
    // Cookie and Set-Cookie values include multiple attributes; redact the
    // complete structured header line rather than attempting to enumerate
    // every cookie name and attribute.
    .replace(/((?:^|[\r\n])[^\r\n]*?\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gim, "$1***redacted***")
    // Authorization schemes can contain a scheme plus a credential, such as
    // `Bearer token` or `Basic base64`; consume both under the known header.
    .replace(/\b((?:proxy-)?authorization)(\s*:\s*)((?:(?:[A-Za-z][A-Za-z0-9_-]*)\s+[^\r\n]+|[^\s,;}\]]+))/gi, (_match, name: string, separator: string, value: string) => isBenignAuthorizationValue(value) ? _match : `${name}${separator}***redacted***`)
    // Explicit credential-bearing headers with a single value.
    .replace(/\b((?:x-api-key|x-goog-api-key|x-auth-token|x-access-token|x-refresh-token|x-session-token|x-client-secret|api-key|api-token))(\s*:\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi, (_match, name: string, separator: string, value: string) => `${name}${separator}${redactedValue(value)}`)
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "Bearer ***redacted***")
    // Only known credential names and env-style suffixes are eligible. In
    // particular, ordinary `key`, `cache-key`, and object fields survive.
    .replace(/(?<![A-Za-z0-9_])([A-Za-z0-9][A-Za-z0-9_-]*)(["']?)(\s*[:=]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi, (match: string, name: string, keyQuote: string, separator: string, value: string) => {
      const normalized = normalizedCredentialName(name);
      if (!isSensitiveAssignmentName(name) || ((normalized === "authorization" || normalized === "proxy_authorization" || normalized === "auth") && isBenignAuthorizationValue(value))) return match;
      return `${name}${keyQuote}${separator}${redactedValue(value)}`;
    })
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***redacted***@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/gi, "***redacted***");
}
