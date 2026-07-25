import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

export interface WebAppRouteOptions {
  /**
   * Absolute path to the built web bundle (the directory containing
   * `index.html`). When omitted or missing, the service stays CLI-only and
   * serves no `/app` surface.
   */
  webRoot?: string;
}

// The same structured error envelope the rest of the API returns, so an unknown
// route is indistinguishable from a handler-thrown NOT_FOUND to any client.
const NOT_FOUND_BODY = {
  version: 1,
  error: { code: "NOT_FOUND", message: "Not found" },
} as const;

/**
 * Serve the built Morrow web application at `/app` from the local orchestrator.
 *
 * Design goals:
 * - Real built files (hashed assets, favicon) are served from disk under
 *   `/app/`.
 * - Client-side deep links (`/app/missions/123`) fall back to the SPA shell so a
 *   browser refresh works.
 * - Nothing intercepts `/api/*`, `/`, or any existing route. A missing `/app`
 *   asset returns the structured JSON 404, never the HTML shell, so a broken
 *   asset reference can never be masked as a 200 document.
 * - When no web bundle is present the service is unchanged and remains
 *   CLI-only; only the JSON not-found envelope is installed for consistency.
 */
export function registerWebAppRoutes(
  app: FastifyInstance,
  options: WebAppRouteOptions,
): void {
  const webRoot = options.webRoot?.trim();
  const indexPath = webRoot ? join(webRoot, "index.html") : null;

  if (!webRoot || !indexPath || !existsSync(indexPath)) {
    // CLI-only: keep the service exactly as it was, but answer unknown routes
    // with the API's structured envelope instead of Fastify's default body.
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send(NOT_FOUND_BODY);
    });
    return;
  }

  // Read the shell once at startup; it is a small built artifact that never
  // changes for the life of the process.
  const indexHtml = readFileSync(indexPath);

  // `wildcard: false` registers one route per real file, so a request for a
  // path with no matching file is simply unrouted and reaches the not-found
  // handler below — @fastify/static never answers with its own 404.
  void app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/app/",
    wildcard: false,
    index: ["index.html"],
  });

  // Canonical base path. Set status + Location explicitly so behavior does not
  // depend on `reply.redirect`'s argument order across Fastify versions.
  app.get("/app", (_request, reply) => {
    reply.code(308).header("location", "/app/").send();
  });

  app.setNotFoundHandler((request, reply) => {
    const path = (request.raw.url ?? "").split("?")[0] ?? "";
    const accept = request.headers.accept ?? "";
    const isAppRoute = path === "/app" || path.startsWith("/app/");
    // Asset requests must fail loudly (404) rather than silently returning the
    // SPA shell — a missing hashed asset is a real error, not a client route.
    const isAsset = path.startsWith("/app/assets/");
    if (
      request.method === "GET" &&
      isAppRoute &&
      !isAsset &&
      accept.includes("text/html")
    ) {
      reply.code(200).type("text/html; charset=utf-8").send(indexHtml);
      return;
    }
    reply.code(404).send(NOT_FOUND_BODY);
  });
}
