-- DDL no-op (see 000006_add_pause_states.up.sql for the rationale).
-- The Go-level state machine still has to be reverted in code if you want to
-- truly roll back this change; this file only exists to keep migrate's
-- forward/backward count balanced.

-- intentionally empty
SELECT 1;
