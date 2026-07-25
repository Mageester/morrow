import { Hono } from "hono";
import { Webhook } from "svix";
import { upsertUser, getOrCreateAccountForUser } from "../db/accounts.js";
import type { Bindings } from "../index.js";

// Hono/Workers isn't one of Clerk's SDK-adapter-supported frameworks
// (Next.js/Express/Astro/Nuxt/Fastify/React Router/TanStack Start), so this
// verifies the Svix signature directly rather than via a framework adapter —
// the same mechanism those adapters wrap internally.

export const webhookRoutes = new Hono<{ Bindings: Bindings }>();

interface ClerkUserEventData {
  id: string;
  email_addresses?: Array<{ email_address: string }>;
}

webhookRoutes.post("/webhooks/clerk", async (c) => {
  const payload = await c.req.text();
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.text("Missing svix headers", 400);
  }

  let event: { type: string; data: unknown };
  try {
    const wh = new Webhook(c.env.CLERK_WEBHOOK_SIGNING_SECRET);
    event = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as { type: string; data: unknown };
  } catch (error) {
    console.error("Clerk webhook verification failed:", error);
    return c.text("Verification failed", 400);
  }

  if (event.type === "user.created" || event.type === "user.updated") {
    const data = event.data as ClerkUserEventData;
    const email = data.email_addresses?.[0]?.email_address ?? `${data.id}@unknown.invalid`;
    await upsertUser(c.env, { id: data.id, email });
    await getOrCreateAccountForUser(c.env, data.id);
  }

  return c.text("OK", 200);
});
