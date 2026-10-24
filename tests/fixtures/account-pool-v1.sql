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
