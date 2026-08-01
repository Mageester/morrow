import { createClerkClient } from "@clerk/backend";

// Shared by both the Clerk webhook (Phase 2) and the auth middleware's
// self-heal path. Webhooks are async/eventually-consistent — Clerk's own
// guidance is to never depend on webhook delivery for a synchronous flow
// like "user just signed up, read their account back". touchOrCreateUser +
// getOrCreateAccountForUser make the auth middleware self-sufficient even if
// the webhook hasn't landed yet; the webhook path just becomes a second,
// idempotent caller of the same upsert.

interface AccountsEnv {
  DB: D1Database;
  CLERK_SECRET_KEY: string;
}

export async function upsertUser(env: Pick<AccountsEnv, "DB">, user: { id: string; email: string }): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified_at, created_at, last_login_at) VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at`,
  )
    .bind(user.id, user.email, now, now)
    .run();
}

/** Self-heal path: fetches the user from Clerk's Backend API when no local row exists yet. */
export async function touchOrCreateUser(env: AccountsEnv, clerkUserId: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(clerkUserId).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(new Date().toISOString(), clerkUserId).run();
    return;
  }
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const clerkUser = await clerk.users.getUser(clerkUserId);
  const email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? `${clerkUserId}@unknown.invalid`;
  await upsertUser(env, { id: clerkUserId, email });
}

export async function getOrCreateAccountForUser(env: Pick<AccountsEnv, "DB">, clerkUserId: string): Promise<string> {
  const existingAccount = await env.DB.prepare(`SELECT id FROM accounts WHERE owner_user_id = ?`)
    .bind(clerkUserId)
    .first<{ id: string }>();
  if (existingAccount) return existingAccount.id;

  const now = new Date().toISOString();
  const accountId = crypto.randomUUID();
  const user = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(clerkUserId).first<{ email: string }>();
  await env.DB.prepare(`INSERT INTO accounts (id, owner_user_id, name, plan_id, created_at) VALUES (?, ?, ?, 'free', ?)`)
    .bind(accountId, clerkUserId, user?.email ?? "My Account", now)
    .run();
  await env.DB.prepare(`INSERT INTO account_members (account_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
    .bind(accountId, clerkUserId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_log (id, account_id, actor_user_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, 'account.created', '{}', ?)`,
  )
    .bind(crypto.randomUUID(), accountId, clerkUserId, now)
    .run();

  return accountId;
}
