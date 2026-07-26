import type { MiddlewareHandler } from "hono";

export const ALLOWED_ORIGINS = [
  "http://localhost:4322",
  "http://127.0.0.1:4322",
  "https://app.getaxiom.ca",
  "https://morrowapp.getaxiom.ca",
  "https://morrow-app-65l.pages.dev",
];

const PAGES_PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.morrow-app-65l\.pages\.dev$/;
const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization";
const MAX_AGE = "86400";

export function resolveAllowedOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin) || PAGES_PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}

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

export function withCors<T extends Response>(res: T, origin: string | null | undefined): T {
  for (const [key, value] of Object.entries(corsHeaders(origin))) res.headers.set(key, value);
  return res;
}

export function corsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    await next();
    for (const [key, value] of Object.entries(corsHeaders(origin))) c.res.headers.set(key, value);
  };
}
