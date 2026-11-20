ALTER TABLE push_preferences ADD COLUMN defaults_blocked INTEGER NOT NULL DEFAULT 0;
UPDATE push_preferences SET defaults_blocked=1 WHERE enabled=0;
CREATE TABLE push_default_decisions (actor_id TEXT NOT NULL, policy_id TEXT NOT NULL, PRIMARY KEY(actor_id,policy_id)) STRICT;
CREATE TABLE push_target_opt_outs (actor_id TEXT NOT NULL, target_key TEXT NOT NULL, PRIMARY KEY(actor_id,target_key)) STRICT;