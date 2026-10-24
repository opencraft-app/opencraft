/** Additive v6 of the existing OpenCraft Host state database. */
export const OPENCRAFT_HOST_TOKEN_USAGE = `
CREATE TABLE token_usage_scopes (
  server_id TEXT PRIMARY KEY, enabled_at_ms INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL
) STRICT;
CREATE TABLE token_usage_coverage (
  id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, starts_ms INTEGER NOT NULL, ends_ms INTEGER
) STRICT;
CREATE INDEX token_usage_coverage_scope ON token_usage_coverage(server_id,starts_ms,ends_ms);
CREATE TABLE token_usage_turns (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  started_ms INTEGER NOT NULL, execution_state TEXT NOT NULL CHECK(execution_state IN ('running','completed','failed','interrupted')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('human','system','unknown')),
  participants_complete INTEGER NOT NULL CHECK(participants_complete IN (0,1)),
  usage_complete INTEGER NOT NULL CHECK(usage_complete IN (0,1)),
  responses_complete INTEGER NOT NULL CHECK(responses_complete IN (0,1)),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1)),
  observed_tokens TEXT, allocation_state TEXT NOT NULL CHECK(allocation_state IN ('settled','provisional','pending','system','unknown')),
  revision INTEGER NOT NULL, PRIMARY KEY(server_id,thread_id,turn_id)
) STRICT;
CREATE INDEX token_usage_turns_date ON token_usage_turns(server_id,started_ms,thread_id,turn_id);
CREATE TABLE token_usage_inputs (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  actor_id TEXT, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','unknown')),
  mode TEXT NOT NULL CHECK(mode IN ('start','steer')),
  admission TEXT NOT NULL CHECK(admission IN ('confirmed','pending','rejected')),
  PRIMARY KEY(server_id,thread_id,input_id)
) STRICT;
CREATE INDEX token_usage_inputs_turn ON token_usage_inputs(server_id,thread_id,turn_id,admission);
CREATE TABLE token_usage_sources (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  lineage TEXT NOT NULL, source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('response','turn-snapshot')),
  source_version INTEGER NOT NULL, provider TEXT, model TEXT, counts_json TEXT NOT NULL,
  PRIMARY KEY(server_id,thread_id,turn_id,lineage,source_kind,source_id)
) STRICT;
CREATE TABLE token_usage_allocations (
  server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  model_key TEXT NOT NULL, provider TEXT, model TEXT, actor_id TEXT NOT NULL,
  tokens TEXT NOT NULL, PRIMARY KEY(server_id,thread_id,turn_id,model_key,actor_id)
) STRICT;
CREATE INDEX token_usage_allocations_actor ON token_usage_allocations(server_id,actor_id,thread_id,turn_id);
CREATE TABLE token_usage_checkpoints (
  server_id TEXT NOT NULL, lineage TEXT NOT NULL, cursor TEXT NOT NULL,
  PRIMARY KEY(server_id,lineage)
) STRICT;
`;
