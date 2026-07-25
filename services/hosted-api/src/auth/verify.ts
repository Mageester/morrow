import { verifyToken } from "@clerk/backend";
import { ApiErrorSchema } from "@morrow/hosted-contracts";
import type { MiddlewareHandler } from "hono";
import { getOrCreateAccountForUser, touchOrCreateUser } from "../db/accounts.js";
import type { Bindings } from "../index.js";

export type AuthVariables = {
  clerkUserId: string;
  accountId: string;
};

export const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: AuthVariables }> = async (c, next) => {
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) {
    return c.json(ApiErrorSchema.parse({ error: { code: "UNAUTHORIZED", message: "Missing session token." } }), 401);
  }

  let clerkUserId: string;
  try {
    const payload = await verifyToken(token, { secretKey: c.env.CLERK_SECRET_KEY });
    clerkUserId = payload.sub;
  } catch {
    return c.json(ApiErrorSchema.parse({ error: { code: "UNAUTHORIZED", message: "Invalid or expired session token." } }), 401);
  }

  // Self-heal rather than depend on webhook timing (Clerk's own guidance —
  // webhooks are eventually consistent, never a synchronous-flow dependency).
  await touchOrCreateUser(c.env, clerkUserId);
  const accountId = await getOrCreateAccountForUser(c.env, clerkUserId);

  c.set("clerkUserId", clerkUserId);
  c.set("accountId", accountId);
  await next();
};
