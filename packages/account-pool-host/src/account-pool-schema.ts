import type { SqlMigration } from "@opencraft/sql/migrations";

// Published `account-pool.sqlite` migrations. Runtime-neutral so any owner of
// the account pool (the Node file owner today, a Durable Object later) applies
// the same text and checksums; later versions come from the generated store
// registry (`resolveStoreMigrations("account-pool-host", ...)`).

export const ACCOUNT_POOL_BASELINE_SQL = `
CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  upstream_account_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  email TEXT,
  subscription_type TEXT,
  rate_limit_tier TEXT,
  last_used_at INTEGER,
  last_used_host_id TEXT
) STRICT;
CREATE TABLE pool_affinity (
  affinity_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE,
  last_used_at INTEGER NOT NULL
) STRICT;
CREATE TABLE pool_active_account (
  provider TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE pool_quota (
  account_id TEXT PRIMARY KEY REFERENCES pool_accounts(id) ON DELETE CASCADE,
  utilization REAL,
  reset_at INTEGER,
  held_until INTEGER,
  error TEXT,
  observed_at INTEGER NOT NULL,
  limit_windows_json TEXT NOT NULL DEFAULT '[]'
) STRICT
`.trim();

export const ACCOUNT_POOL_RESET_CREDITS_SQL = `
ALTER TABLE pool_accounts ADD COLUMN reset_credit_count INTEGER CHECK(reset_credit_count >= 0);
ALTER TABLE pool_accounts ADD COLUMN reset_credits_observed_at INTEGER;
`.trim();

// Preserve existing accounts' credit behavior; new accounts opt in explicitly.
export const ACCOUNT_POOL_CREDIT_POLICY_SQL = `ALTER TABLE pool_accounts ADD COLUMN allow_credits INTEGER NOT NULL DEFAULT 1 CHECK(allow_credits IN (0,1));`;

export const ACCOUNT_POOL_MIGRATIONS: readonly SqlMigration[] = [
  { version: 1, name: "account-pool", sql: ACCOUNT_POOL_BASELINE_SQL },
  { version: 2, name: "codex-reset-credit-count", sql: ACCOUNT_POOL_RESET_CREDITS_SQL },
  { version: 3, name: "codex-account-credit-policy", sql: ACCOUNT_POOL_CREDIT_POLICY_SQL },
];
