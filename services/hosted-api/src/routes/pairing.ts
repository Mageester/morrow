import { Hono } from "hono";
import {
  AccountPlanIdSchema,
  ApiErrorSchema,
  EntitlementResponseSchema,
  PairingCodeCreateResponseSchema,
  PairingRedeemRequestSchema,
  PairingRedeemResponseSchema,
  SubscriptionStatusSchema,
} from "@morrow/hosted-contracts";
import { requireAuth, type AuthVariables } from "../auth/verify.js";
import type { Bindings } from "../index.js";
import { randomPairingCode, randomToken, sha256Hex } from "../lib/crypto.js";

// See Plans/generic-sprouting-dragon.md Phase 4. Now that Phase 2 (Clerk
// auth) is real, /pair/create can know which account is asking — it's
// authenticated via requireAuth (dashboard calls it with the signed-in
// user's session token). /pair/redeem and /entitlement remain unauthenticated
// by user session — they're called by the local orchestrator using the
// pairing code / device token instead.

interface PairingCodeRecord {
  accountId: string;
}

const PAIRING_CODE_TTL_SECONDS = 600;

export const pairingRoutes = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

pairingRoutes.post("/pair/create", requireAuth, async (c) => {
  const accountId = c.get("accountId");
  const code = randomPairingCode();
  await c.env.PAIRING_CODES.put(code, JSON.stringify({ accountId } satisfies PairingCodeRecord), {
    expirationTtl: PAIRING_CODE_TTL_SECONDS,
  });
  return c.json(PairingCodeCreateResponseSchema.parse({ code, expiresInSeconds: PAIRING_CODE_TTL_SECONDS }));
});

pairingRoutes.post("/pair/redeem", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = PairingRedeemRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      ApiErrorSchema.parse({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request body." },
      }),
      400,
    );
  }

  const raw = await c.env.PAIRING_CODES.get(parsed.data.code);
  if (!raw) {
    return c.json(
      ApiErrorSchema.parse({
        error: { code: "PAIRING_CODE_INVALID", message: "Code not recognized or expired." },
      }),
      404,
    );
  }
  const record = JSON.parse(raw) as PairingCodeRecord;

  const deviceToken = randomToken();
  const deviceTokenHash = await sha256Hex(deviceToken);
  const pairedAgentId = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO paired_agents (id, account_id, device_label, device_token_hash, status, orchestrator_version, paired_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
  )
    .bind(
      pairedAgentId,
      record.accountId,
      parsed.data.deviceLabel,
      deviceTokenHash,
      parsed.data.orchestratorVersion ?? null,
      now,
    )
    .run();

  // One-time use — the same code can never be redeemed twice.
  await c.env.PAIRING_CODES.delete(parsed.data.code);

  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, account_id, actor_user_id, event_type, metadata_json, created_at)
     VALUES (?, ?, NULL, 'agent.paired', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      record.accountId,
      JSON.stringify({ pairedAgentId, deviceLabel: parsed.data.deviceLabel }),
      now,
    )
    .run();

  return c.json(
    PairingRedeemResponseSchema.parse({ pairedAgentId, deviceToken, accountId: record.accountId }),
  );
});

pairingRoutes.get("/entitlement", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) {
    return c.json(
      ApiErrorSchema.parse({ error: { code: "UNAUTHORIZED", message: "Missing device token." } }),
      401,
    );
  }
  const tokenHash = await sha256Hex(token);

  const agent = await c.env.DB.prepare(
    `SELECT account_id as accountId FROM paired_agents WHERE device_token_hash = ? AND status = 'active'`,
  )
    .bind(tokenHash)
    .first<{ accountId: string }>();

  if (!agent) {
    return c.json(
      ApiErrorSchema.parse({
        error: { code: "UNAUTHORIZED", message: "Unrecognized or revoked device token." },
      }),
      401,
    );
  }

  await c.env.DB.prepare(`UPDATE paired_agents SET last_seen_at = ? WHERE device_token_hash = ?`)
    .bind(new Date().toISOString(), tokenHash)
    .run();

  const account = await c.env.DB.prepare(`SELECT plan_id as planId FROM accounts WHERE id = ?`)
    .bind(agent.accountId)
    .first<{ planId: string }>();

  if (!account) {
    return c.json(
      ApiErrorSchema.parse({
        error: { code: "ACCOUNT_NOT_FOUND", message: "Paired account no longer exists." },
      }),
      404,
    );
  }

  const subscription = await c.env.DB.prepare(
    `SELECT status FROM subscriptions WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(agent.accountId)
    .first<{ status: string }>();

  // D1 has no CHECK constraint on these columns, so validate at this
  // boundary rather than trusting the raw row shape.
  const planId = AccountPlanIdSchema.parse(account.planId);
  const subscriptionStatus = SubscriptionStatusSchema.nullable().parse(subscription?.status ?? null);
  // Free plan is always active — no paid tier exists yet (confirmed
  // 2026-07-24). Once one does, `active` should also require
  // subscriptionStatus in {trialing, active} for non-free plans.
  const active = planId === "free" || subscriptionStatus === "trialing" || subscriptionStatus === "active";

  return c.json(
    EntitlementResponseSchema.parse({
      accountId: agent.accountId,
      planId,
      subscriptionStatus,
      active,
    }),
  );
});
