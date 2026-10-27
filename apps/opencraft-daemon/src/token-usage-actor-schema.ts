/** v11: rebuildable actor/day aggregates; authoritative allocations are unchanged. */
export const OPENCRAFT_HOST_TOKEN_USAGE_ACTORS = `
CREATE TABLE token_usage_actor_daily (
 server_id TEXT NOT NULL, actor_id TEXT NOT NULL, day TEXT NOT NULL,
 model_filter INTEGER NOT NULL CHECK(model_filter IN (0,1)), model_key TEXT NOT NULL,
 tokens TEXT NOT NULL, turns INTEGER NOT NULL CHECK(turns>=0),
 PRIMARY KEY(server_id,actor_id,day,model_filter,model_key)
) STRICT;
CREATE TABLE token_usage_turn_actor_projections (
 server_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, value_json TEXT NOT NULL,
 PRIMARY KEY(server_id,thread_id,turn_id)
) STRICT;
UPDATE token_usage_projection_state SET ready=0,cursor_thread='',cursor_turn='';
`;
