import { Hono } from "hono";
import { cors } from "hono/cors";
import { HealthResponseSchema } from "@morrow/hosted-contracts";
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

// apps/dashboard (Cloudflare Pages) is a different origin from this Worker —
// dev uses vite.config.ts's proxy instead (same-origin, no CORS needed), so
// this only matters in production. Named allowlist, not a wildcard: this API
// issues Bearer-token-authenticated responses, never safe to allow any origin.
const ALLOWED_ORIGINS = [
  "http://localhost:4322",
  "https://app.getaxiom.ca",
  // Cloudflare-assigned Pages domain (pages.dev names are globally unique,
  // so ours got a random suffix rather than the bare project name).
  "https://morrow-app-65l.pages.dev",
];
const PAGES_PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.morrow-app-65l\.pages\.dev$/;

app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      if (ALLOWED_ORIGINS.includes(origin) || PAGES_PREVIEW_ORIGIN.test(origin)) return origin;
      return undefined;
    },
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST"],
  }),
);

app.get("/health", (c) => c.json(HealthResponseSchema.parse({ status: "ok" })));
app.route("/api", pairingRoutes);
app.route("/api", webhookRoutes);

export default app;
