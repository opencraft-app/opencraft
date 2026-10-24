/** v9: derived coverage flag and covering indexes; no token arithmetic in SQL. */
export const OPENCRAFT_HOST_TOKEN_USAGE_QUERY = `
ALTER TABLE token_usage_turns ADD COLUMN unknown_model INTEGER NOT NULL DEFAULT 0 CHECK(unknown_model IN (0,1));
UPDATE token_usage_turns SET unknown_model=EXISTS(SELECT 1 FROM token_usage_buckets b
 WHERE b.server_id=token_usage_turns.server_id AND b.thread_id=token_usage_turns.thread_id
 AND b.turn_id=token_usage_turns.turn_id AND (b.provider IS NULL OR b.model IS NULL));
CREATE INDEX token_usage_buckets_query ON token_usage_buckets(server_id,thread_id,turn_id,model_key,tokens,provider,model);
CREATE INDEX token_usage_turns_query ON token_usage_turns(server_id,started_ms,thread_id,turn_id,frozen,allocation_state,observed_tokens,unknown_model);
CREATE INDEX token_usage_inputs_participants_query ON token_usage_inputs(server_id,thread_id,turn_id,admission,actor_kind,actor_id);
CREATE INDEX token_usage_inputs_actor_query ON token_usage_inputs(server_id,actor_id,actor_kind,admission,thread_id,turn_id);
CREATE TABLE token_usage_daily (
 server_id TEXT NOT NULL, day TEXT NOT NULL, model_filter INTEGER NOT NULL CHECK(model_filter IN (0,1)),
 model_key TEXT NOT NULL, allocation_state TEXT NOT NULL, tokens TEXT NOT NULL,
 turns INTEGER NOT NULL, missing_usage INTEGER NOT NULL, unknown_models INTEGER NOT NULL,
 PRIMARY KEY(server_id,day,model_filter,model_key,allocation_state)
) STRICT;
CREATE TABLE token_usage_turn_projections (
 server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, value_json TEXT NOT NULL,
 PRIMARY KEY(server_id,thread_id,turn_id)
) STRICT;
CREATE TABLE token_usage_projection_state (
 server_id TEXT PRIMARY KEY, ready INTEGER NOT NULL CHECK(ready IN (0,1)),
 cursor_thread TEXT NOT NULL, cursor_turn TEXT NOT NULL
) STRICT;
`;
