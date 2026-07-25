-- One row per authenticated identity (synced from the Clerk webhook,
-- no password ever stored here).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- The billing entity. 1:1 with the creating user in v1 (no teams yet) —
-- modeled separately now so team billing later needs no destructive migration.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL
);
CREATE INDEX accounts_owner_idx ON accounts(owner_user_id);

-- Unused by any v1 UI (owner-only); exists so teams don't require a
-- destructive schema change later.
CREATE TABLE account_members (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

-- Synced from Stripe webhooks only — nothing else writes this table.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  price_id TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX subscriptions_account_idx ON subscriptions(account_id);
CREATE INDEX subscriptions_customer_idx ON subscriptions(stripe_customer_id);

-- Webhook idempotency ledger (Stripe retries on any non-2xx response).
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- One row per local orchestrator install that completed device pairing.
-- The token is stored hashed; the plaintext lives only in the user's local
-- MORROW_HOME secrets file, same pattern as provider API keys today.
CREATE TABLE paired_agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_label TEXT NOT NULL,
  device_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  orchestrator_version TEXT,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX paired_agents_account_idx ON paired_agents(account_id);

-- A read-only index of local projects for the dashboard to list — never a
-- source of truth. Real project state stays in the local orchestrator's own
-- SQLite (packages/contracts ProjectSchema is NOT touched by this).
CREATE TABLE project_registry (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  paired_agent_id TEXT NOT NULL REFERENCES paired_agents(id) ON DELETE CASCADE,
  local_project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  UNIQUE(paired_agent_id, local_project_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_account_idx ON audit_log(account_id);
