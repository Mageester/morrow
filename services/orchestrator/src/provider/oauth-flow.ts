/**
 * Subscription OAuth (PKCE) for Claude (Anthropic) and Codex (OpenAI).
 *
 * ⚠️ Read this before changing anything here.
 *
 * This implements the same "log in with your subscription" flow that the
 * official Claude Code and Codex CLIs use. It authenticates against the
 * providers' real OAuth endpoints using their first-party public client IDs and
 * the PKCE (RFC 7636) authorization-code flow. It does NOT scrape cookies, reuse
 * an existing browser session, or fabricate undocumented endpoints — but it DOES
 * reuse first-party client IDs, which is a deliberate product decision made by
 * the operator (see docs and the in-app warning). It may be subject to the
 * providers' terms of service, and provider-side changes can break it at any
 * time. Tokens are stored locally (owner-readable) and never leave this machine
 * except to the provider's own token endpoint.
 *
 * The flow is intentionally "manual code" friendly: we generate an authorization
 * URL, the user signs in in their own browser, and pastes back the resulting
 * authorization code (or the full redirected URL). This avoids binding a local
 * callback port and works identically on every platform.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMorrowHome } from "../home.js";

export type OAuthProviderId = "anthropic" | "openai";

interface OAuthProviderConfig {
  id: OAuthProviderId;
  label: string;
  /** Provider id used by the model registry / secrets ("anthropic", "openai"). */
  providerId: "anthropic" | "openai";
  authorizeUrl: string;
  tokenUrl: string;
  /** First-party public OAuth client id (same one the official CLI uses). */
  clientId: string;
  scopes: string[];
  redirectUri: string;
  /** Token-endpoint encoding the provider expects. */
  tokenBody: "json" | "form";
  /** Extra static params appended to the authorization URL. */
  extraAuthorizeParams?: Record<string, string>;
  /** Non-secret, user-facing security/ToS note shown in the UI. */
  warning: string;
}

/**
 * First-party OAuth client configuration. These client IDs are the public
 * identifiers shipped in the respective official CLIs; reusing them is what
 * makes "sign in with your subscription" possible from a third-party app.
 */
export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  anthropic: {
    id: "anthropic",
    label: "Claude (Anthropic)",
    providerId: "anthropic",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    tokenBody: "json",
    extraAuthorizeParams: { code: "true" },
    warning:
      "Signs in with your Claude (Pro/Max) subscription using Anthropic's first-party client id, the same way Claude Code does. This reuses a first-party OAuth client and may be subject to Anthropic's terms of service. Tokens are stored locally on this machine. Subscription inference is intended for Anthropic's own tools and may be rejected.",
  },
  openai: {
    id: "openai",
    label: "Codex / ChatGPT (OpenAI)",
    providerId: "openai",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: ["openid", "profile", "email", "offline_access"],
    redirectUri: "http://localhost:1455/auth/callback",
    tokenBody: "form",
    extraAuthorizeParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true" },
    warning:
      "Signs in with your ChatGPT/Codex subscription using OpenAI's first-party client id, the same way the Codex CLI does. This reuses a first-party OAuth client and may be subject to OpenAI's terms of service. ChatGPT subscription tokens target OpenAI's Codex/ChatGPT backend and may require additional configuration to use for general chat. Tokens are stored locally on this machine.",
  },
};

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which the access token expires (best-effort). */
  expiresAt?: number;
  obtainedAt: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuthProviderStatus {
  id: OAuthProviderId;
  label: string;
  providerId: string;
  status: "connected" | "disconnected" | "expired";
  /** ISO timestamp of expiry, if known. */
  expiresAt: string | null;
  scope: string | null;
  warning: string;
}

type TokenStore = Partial<Record<OAuthProviderId, StoredOAuthToken>>;

// ── Token persistence ────────────────────────────────────────────────────────

function tokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveMorrowHome(env), "oauth.json");
}

function readTokenStore(env: NodeJS.ProcessEnv = process.env): TokenStore {
  const path = tokenStorePath(env);
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as TokenStore;
  } catch {
    return {};
  }
}

function writeTokenStore(store: TokenStore, env: NodeJS.ProcessEnv = process.env): void {
  const path = tokenStorePath(env);
  mkdirSync(join(resolveMorrowHome(env)), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows ignores POSIX modes; best effort. */
  }
}

/**
 * Synchronous read of a stored, non-expired access token for the model registry.
 * Returns null if there is no token or it is expired (callers then fall back to
 * an API key). Does NOT refresh — refresh happens in the async paths.
 */
export function getStoredAccessTokenSync(
  providerId: "anthropic" | "openai",
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const oauthId = (Object.keys(OAUTH_PROVIDERS) as OAuthProviderId[]).find(
    (k) => OAUTH_PROVIDERS[k].providerId === providerId
  );
  if (!oauthId) return null;
  const token = readTokenStore(env)[oauthId];
  if (!token) return null;
  if (token.expiresAt && token.expiresAt <= Date.now() + 5_000) return null;
  return token.accessToken;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

// In-memory pending authorizations, keyed by provider. A local single-user
// server only ever has one in-flight login per provider; a restart cancels it.
const pending = new Map<OAuthProviderId, PendingAuth>();

export function isOAuthProvider(id: string): id is OAuthProviderId {
  return id === "anthropic" || id === "openai";
}

/**
 * Build the authorization URL the user opens in their browser. Stores the PKCE
 * verifier + state in memory for the subsequent code exchange.
 */
export function startAuthorization(id: OAuthProviderId): { authorizeUrl: string; redirectUri: string; manual: true } {
  const cfg = OAUTH_PROVIDERS[id];
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));
  pending.set(id, { verifier, state, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(cfg.extraAuthorizeParams ?? {}),
  });
  return { authorizeUrl: `${cfg.authorizeUrl}?${params.toString()}`, redirectUri: cfg.redirectUri, manual: true };
}

/**
 * Normalize whatever the user pasted back into { code, state }. Accepts a raw
 * code, a `code#state` pair (Anthropic's manual callback format), or the full
 * redirected URL (OpenAI's localhost callback).
 */
function parseCodeInput(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  // Full URL with query params?
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code) return { code, ...(state ? { state } : {}) };
  } catch {
    /* not a URL */
  }
  // `code#state` form.
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#");
    return { code: code!.trim(), ...(state ? { state: state.trim() } : {}) };
  }
  return { code: trimmed };
}

/**
 * Build a human-readable error message from a token-endpoint failure. OAuth
 * error bodies are inconsistent: `error_description` may be absent and `error`
 * may itself be a nested object, so naively doing `error_description || error`
 * and throwing it produced the useless "[object Object]" the UI surfaced.
 * Always coerce to a non-empty string and never echo back anything but the
 * provider's own (non-secret) error text.
 */
export function tokenErrorMessage(status: number, rawBody: string): string {
  const fallback = `Token request failed (HTTP ${status})`;
  const text = (rawBody ?? "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text ? `${fallback}: ${text.slice(0, 200)}` : fallback;
  }
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const m = (v as any).message ?? (v as any).error_description ?? (v as any).error;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
    return null;
  };
  const detail = pick(parsed?.error_description) ?? pick(parsed?.error) ?? pick(parsed?.message);
  if (detail) return detail;
  // Structured but unrecognized: serialize compactly rather than "[object Object]".
  return text ? `${fallback}: ${text.slice(0, 200)}` : fallback;
}

async function postToken(cfg: OAuthProviderConfig, fields: Record<string, string>): Promise<StoredOAuthToken> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string;
  if (cfg.tokenBody === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields).toString();
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(tokenErrorMessage(res.status, text));
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Token endpoint returned a non-JSON response.");
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.expires_in === "number" ? { expiresAt: now + json.expires_in * 1000 } : {}),
    obtainedAt: now,
    ...(json.scope ? { scope: json.scope } : {}),
    ...(json.token_type ? { tokenType: json.token_type } : {}),
  };
}

/** Exchange a pasted authorization code for tokens and persist them. */
export async function exchangeCode(
  id: OAuthProviderId,
  codeInput: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthProviderStatus> {
  const cfg = OAUTH_PROVIDERS[id];
  const pend = pending.get(id);
  if (!pend) {
    throw new Error("No pending sign-in for this provider. Start the sign-in flow again.");
  }
  const { code, state } = parseCodeInput(codeInput);
  if (!code) throw new Error("No authorization code found in the pasted value.");
  if (state && state !== pend.state) {
    throw new Error("State mismatch — the authorization response does not match the request. Start again.");
  }
  const token = await postToken(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: pend.verifier,
    ...(state ? { state } : {}),
  });
  if (!token.accessToken) throw new Error("Token endpoint did not return an access token.");
  const store = readTokenStore(env);
  store[id] = token;
  writeTokenStore(store, env);
  pending.delete(id);
  return statusFor(id, token);
}

/** Refresh tokens for a provider if we hold a refresh token. */
export async function refreshTokens(id: OAuthProviderId, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const cfg = OAUTH_PROVIDERS[id];
  const store = readTokenStore(env);
  const existing = store[id];
  if (!existing?.refreshToken) return false;
  const token = await postToken(cfg, {
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken,
    client_id: cfg.clientId,
    ...(cfg.tokenBody === "form" ? { scope: cfg.scopes.join(" ") } : {}),
  });
  // Some providers omit a new refresh token on refresh — keep the old one.
  if (!token.refreshToken && existing.refreshToken) token.refreshToken = existing.refreshToken;
  store[id] = token;
  writeTokenStore(store, env);
  return true;
}

/**
 * Ensure a usable (non-expired) access token, refreshing if needed. Returns the
 * access token, or null if not connected / refresh failed.
 */
export async function getValidAccessToken(
  id: OAuthProviderId,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const store = readTokenStore(env);
  const token = store[id];
  if (!token) return null;
  if (token.expiresAt && token.expiresAt <= Date.now() + 30_000) {
    try {
      const ok = await refreshTokens(id, env);
      if (!ok) return null;
      return readTokenStore(env)[id]?.accessToken ?? null;
    } catch {
      return null;
    }
  }
  return token.accessToken;
}

/** Remove stored tokens for a provider. */
export function signOut(id: OAuthProviderId, env: NodeJS.ProcessEnv = process.env): void {
  const store = readTokenStore(env);
  delete store[id];
  writeTokenStore(store, env);
  pending.delete(id);
}

function statusFor(id: OAuthProviderId, token: StoredOAuthToken | undefined): OAuthProviderStatus {
  const cfg = OAUTH_PROVIDERS[id];
  let status: OAuthProviderStatus["status"] = "disconnected";
  if (token) status = token.expiresAt && token.expiresAt <= Date.now() ? "expired" : "connected";
  return {
    id,
    label: cfg.label,
    providerId: cfg.providerId,
    status,
    expiresAt: token?.expiresAt ? new Date(token.expiresAt).toISOString() : null,
    scope: token?.scope ?? null,
    warning: cfg.warning,
  };
}

/** Connection status for every OAuth provider (no secrets). */
export function oauthStatuses(env: NodeJS.ProcessEnv = process.env): OAuthProviderStatus[] {
  const store = readTokenStore(env);
  return (Object.keys(OAUTH_PROVIDERS) as OAuthProviderId[]).map((id) => statusFor(id, store[id]));
}
