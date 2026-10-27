/** Append-only identity bindings. Published Host migrations are never edited. */
export const OPENCRAFT_HOST_EXECUTION_LEASES = `
CREATE TABLE execution_submissions (
  thread_id TEXT NOT NULL, input_id TEXT NOT NULL,
  principal_json TEXT, ownership TEXT NOT NULL CHECK(ownership IN ('human','unowned','unknown')),
  submitted_at_ms INTEGER NOT NULL,
  admission TEXT NOT NULL DEFAULT 'accepted' CHECK(admission IN ('pending','accepted','unknown')),
  input_kind TEXT NOT NULL DEFAULT 'start' CHECK(input_kind IN ('start','queue','steer','system')),
  PRIMARY KEY(thread_id,input_id)
) STRICT;
CREATE TABLE execution_queue_inputs (
  thread_id TEXT NOT NULL, queue_id TEXT NOT NULL, input_id TEXT NOT NULL,
  PRIMARY KEY(thread_id,queue_id)
) STRICT;
CREATE TABLE execution_leases (
  execution_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, input_id TEXT NOT NULL,
  generation INTEGER NOT NULL, turn_id TEXT, engine_incarnation TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','active','ended','unknown','rejected')),
  admitted_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  UNIQUE(thread_id,generation), UNIQUE(thread_id,turn_id)
) STRICT;
CREATE INDEX execution_leases_origin ON execution_leases(thread_id,admitted_at_ms,ended_at_ms);
`;

/** v16 / identity v3. Do not edit the published identity schema above. */
export const OPENCRAFT_HOST_EXECUTION_BOOT_CLOCK = `
ALTER TABLE execution_submissions ADD COLUMN admission_token TEXT;
ALTER TABLE execution_leases ADD COLUMN boot_id TEXT;
ALTER TABLE execution_leases ADD COLUMN admitted_at_boot_ms REAL;
ALTER TABLE execution_leases ADD COLUMN ended_at_boot_ms REAL;
CREATE INDEX execution_leases_boot_origin ON execution_leases(thread_id,boot_id,admitted_at_boot_ms,ended_at_boot_ms);
`;
