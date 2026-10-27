/** Additive recovery metadata; published metering v6 remains immutable. */
export const OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME = `
ALTER TABLE token_usage_sources ADD COLUMN observed_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE token_usage_submissions (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL,
  actor_id TEXT, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','unknown')),
  mode TEXT NOT NULL CHECK(mode IN ('start','steer')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('human','system','unknown')),
  submitted_ms INTEGER NOT NULL, PRIMARY KEY(server_id,thread_id,input_id)
) STRICT;
CREATE TABLE token_usage_admissions (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL,
  turn_id TEXT NOT NULL, observed_ms INTEGER NOT NULL,
  PRIMARY KEY(server_id,thread_id,input_id)
) STRICT;
CREATE INDEX token_usage_admissions_turn ON token_usage_admissions(server_id,thread_id,turn_id);
CREATE TABLE token_usage_input_conflicts (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL,
  PRIMARY KEY(server_id,thread_id,input_id)
) STRICT;
CREATE TABLE token_usage_native_terminals (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  PRIMARY KEY(server_id,thread_id,turn_id)
) STRICT;
CREATE TABLE token_usage_buckets (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  model_key TEXT NOT NULL, provider TEXT, model TEXT, tokens TEXT NOT NULL,
  PRIMARY KEY(server_id,thread_id,turn_id,model_key)
) STRICT;
CREATE INDEX token_usage_buckets_model ON token_usage_buckets(server_id,model_key,thread_id,turn_id);
CREATE TABLE token_usage_rollouts (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, path TEXT NOT NULL,
  cursor TEXT NOT NULL, last_success_ms INTEGER, error_kind TEXT,
  PRIMARY KEY(server_id,thread_id)
) STRICT;
CREATE TABLE token_usage_gaps (
  server_id TEXT NOT NULL, gap_key TEXT NOT NULL, thread_id TEXT, turn_id TEXT,
  reason TEXT NOT NULL, starts_ms INTEGER NOT NULL, ends_ms INTEGER,
  PRIMARY KEY(server_id,gap_key)
) STRICT;
`;
