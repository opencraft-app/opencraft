/** v8: proven baselines for newly created empty ephemeral native threads. */
export const OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS = `
CREATE TABLE token_usage_native_counters (
 server_id TEXT NOT NULL, thread_id TEXT NOT NULL, epoch TEXT NOT NULL,
 turn_id TEXT, baseline_json TEXT NOT NULL, cumulative_json TEXT NOT NULL,
 source_version INTEGER NOT NULL, broken INTEGER NOT NULL CHECK(broken IN (0,1)),
 PRIMARY KEY(server_id,thread_id)
) STRICT;
CREATE TABLE token_usage_metadata_scans (
 server_id TEXT NOT NULL, thread_id TEXT NOT NULL, cursor TEXT,
 PRIMARY KEY(server_id,thread_id)
) STRICT;
`;
