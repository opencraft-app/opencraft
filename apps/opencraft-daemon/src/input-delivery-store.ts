
/** Additive v17. Existing queue rows remain the unique message/content owner. */
export const INPUT_DELIVERY_SCHEMA = `
ALTER TABLE opencraft_host_queue RENAME TO opencraft_host_queue_v16;
DROP INDEX opencraft_host_queue_order;
DROP INDEX opencraft_host_queue_state;
CREATE TABLE opencraft_host_queue (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL, input_json TEXT NOT NULL,
  position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed')),
  target_turn_id TEXT, paused_reason TEXT, UNIQUE(thread_id,client_id)
) STRICT;
INSERT INTO opencraft_host_queue SELECT * FROM opencraft_host_queue_v16;
DROP TABLE opencraft_host_queue_v16;
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
INSERT INTO opencraft_input_delivery(thread_id,client_id,native_admission,context_state,revision)
SELECT thread_id,client_id,CASE WHEN state IN ('steering','delivered') THEN 'accepted'
  WHEN state IN ('dispatching','unknown') THEN 'unknown' ELSE 'pending' END,'unobserved',1
FROM opencraft_host_queue;
`;

export { InputDeliveryStore } from "@opencraft/thread-queue";
