import { Hono } from "hono";
import { HealthResponseSchema, ApiErrorSchema } from "@morrow/hosted-contracts";
import { corsMiddleware, withCors } from "./lib/cors.js";
import { pairingRoutes } from "./routes/pairing.js";
import { webhookRoutes } from "./routes/webhooks.js";

// Billing (Phase 3) routes land as this service grows — additive only, same
// as services/orchestrator/src/server.ts's convention.

export type Bindings = {
  DB: D1Database;
  PAIRING_CODES: KVNamespace;
  MORROW_HOSTED_ENV: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Centralized CORS: applied to EVERY route so every response — success,
// validation failure, auth failure, 404, internal error, and OPTIONS
// preflight — carries the correct headers. OPTIONS is short-circuited inside
// this middleware BEFORE requireAuth or any route logic runs (see lib/cors.ts),
// so preflight can never fail behind authentication. The allowlist lives in
// lib/cors.ts and echoes only a validated origin, never a wildcard.
app.use("*", corsMiddleware());

app.get("/health", (c) => c.json(HealthResponseSchema.parse({ status: "ok" })));
app.route("/api", pairingRoutes);
app.route("/api", webhookRoutes);

// notFound and onError produce responses outside the normal middleware
// post-processing path, so stamp CORS headers on them explicitly.
app.notFound((c) =>
  withCors(
    c.json(ApiErrorSchema.parse({ error: { code: "NOT_FOUND", message: "Resource not found." } }), 404),
    c.req.header("origin"),
  ),
);

app.onError((err, c) => {
  console.error("hosted-api unhandled error:", err);
  return withCors(
    c.json(ApiErrorSchema.parse({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } }), 500),
    c.req.header("origin"),
  );
});

export default app;
