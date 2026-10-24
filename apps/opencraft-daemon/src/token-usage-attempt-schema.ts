/** v10: delivery attempts are metadata, never proof of native admission. */
export const OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS = `
CREATE TABLE token_usage_attempts (
 server_id TEXT NOT NULL, attempt_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 input_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('start','steer')),
 actor_id TEXT, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','unknown')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('human','system','unknown')),
 submitted_ms INTEGER NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','accepted','rejected','unknown')),
 turn_id TEXT,
 PRIMARY KEY(server_id,attempt_id)
) STRICT;
CREATE INDEX token_usage_attempts_input ON token_usage_attempts(server_id,thread_id,input_id,outcome);
`;
