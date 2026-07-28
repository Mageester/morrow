import type { MiddlewareHandler } from "hono";

// Centralized CORS policy for every hosted-api response.
//
// apps/dashboard (Cloudflare Pages) is a different origin from this Worker in
// production, so browsers issue a CORS preflight before POST /api/pair/create.
// Dev uses vite.config.ts's proxy instead (same-origin, no CORS needed).
//
// This API issues Bearer-token-authenticated responses, so it MUST echo a
// single validated allowlisted origin, never `*`. The frontend sends the token
// in an Authorization header (not a cookie), so Access-Control-Allow-Credentials
// is intentionally NOT set — see apps/dashboard/src/api/client.ts.

export const ALLOWED_ORIGINS = [
  // Local dashboard dev server (vite.config.ts port 4322). Kept so a developer
  // hitting the deployed Worker directly from localhost still works.
  "http://localhost:4322",
  "http://127.0.0.1:4322",
  // Production dashboard origin.
  "https://morrowapp.getaxiom.ca",
  // Cloudflare-assigned Pages domain (pages.dev names are globally unique, so
  // ours got a random suffix rather than the bare project name).
  "https://morrow-app-65l.pages.dev",
];

// Per-deploy Cloudflare Pages preview URLs, e.g. https://abc123.morrow-app-65l.pages.dev
const PAGES_PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.morrow-app-65l\.pages\.dev$/;

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization";
const MAX_AGE = "86400";

/**
 * Returns the request origin if it is allowlisted, otherwise null. Never
 * returns a wildcard — an unknown origin is rejected by omitting the
 * Access-Control-Allow-Origin header entirely.
 */
export function resolveAllowedOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin) || PAGES_PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}

/**
 * Builds the CORS response headers for a given request origin. `Vary: Origin`
 * is always present (so caches don't serve the wrong ACAO); the allow-*
 * headers are added only when the origin is validated.
 */
export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  const allowed = resolveAllowedOrigin(origin);
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Access-Control-Allow-Methods"] = ALLOW_METHODS;
    headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS;
    headers["Access-Control-Max-Age"] = MAX_AGE;
  }
  return headers;
}

/**
 * Mutates a Response in place to carry the correct CORS headers, then returns
 * it. Used by app.notFound / app.onError, whose responses are produced outside
 * the normal middleware post-processing path.
 */
export function withCors<T extends Response>(res: T, origin: string | null | undefined): T {
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    res.headers.set(key, value);
  }
  return res;
}

/**
 * Middleware applied to every route. OPTIONS preflight requests are answered
 * immediately with a 204 and the CORS headers — BEFORE any authentication or
 * route logic runs — so preflight can never fail behind requireAuth. For all
 * other methods, the downstream response (success OR a handler-returned error
 * such as a 401) gets CORS headers stamped on the way out.
 */
export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");

    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    await next();

    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      c.res.headers.set(key, value);
    }
  };
}
