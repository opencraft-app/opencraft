/**
 * Tables for a database owner adopting the thread queue, in their current
 * shape. An owner copies this into a new migration of its own chain; it is
 * never edited in place once an owner has published it. The legacy Codex Host
 * state database reached the same shape through its own v17 migration.
 */
export const THREAD_QUEUE_SCHEMA = `
CREATE TABLE opencraft_host_queue (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL, input_json TEXT NOT NULL,
  position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed')),
  target_turn_id TEXT, paused_reason TEXT, UNIQUE(thread_id,client_id)
) STRICT;
CREATE INDEX opencraft_host_queue_order ON opencraft_host_queue(thread_id,position,created_at_ms);
CREATE INDEX opencraft_host_queue_state ON opencraft_host_queue(state,thread_id);
CREATE INDEX opencraft_host_queue_turn ON opencraft_host_queue(thread_id,target_turn_id,state);
CREATE TABLE opencraft_input_delivery (
  thread_id TEXT NOT NULL, client_id TEXT NOT NULL,
  native_admission TEXT NOT NULL CHECK(native_admission IN ('pending','accepted','unknown','rejected')),
  context_state TEXT NOT NULL CHECK(context_state IN ('unobserved','recorded')),
  revision INTEGER NOT NULL, PRIMARY KEY(thread_id,client_id),
  FOREIGN KEY(thread_id,client_id) REFERENCES opencraft_host_queue(thread_id,client_id)
) STRICT;
CREATE TABLE opencraft_turn_delivery (
  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','interrupted','failed')),
  observed_at_ms INTEGER NOT NULL, PRIMARY KEY(thread_id,turn_id)
) STRICT;
`;
