-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Add column "daemon_build_id" to table: "computers"
ALTER TABLE `computers` ADD COLUMN `daemon_build_id` text NULL;
-- Add column "im_transport_state" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `im_transport_state` text NOT NULL DEFAULT ('unknown');
-- Add column "im_transport_updated_at" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `im_transport_updated_at` datetime NULL;
-- Create "new_computer_agent_observations" table
CREATE TABLE `new_computer_agent_observations` (`id` text NOT NULL, `server_id` text NOT NULL, `computer_id` text NOT NULL, `agent_id` text NOT NULL, `assignment_epoch` text NOT NULL, `assignment_revision` integer NOT NULL, `config_generation` integer NOT NULL, `credential_version` integer NOT NULL DEFAULT (0), `attempt` integer NOT NULL, `sequence` integer NOT NULL, `launch_id` text NOT NULL, `state` text NOT NULL, `im_transport_state` text NOT NULL DEFAULT ('unknown'), `error_code` text NULL, `accepted_at_ingest` bool NOT NULL DEFAULT (false), `rejection_reason_at_ingest` text NULL, `request_hash` blob NOT NULL, `observed_at` datetime NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "computer_agent_observations" to new temporary table "new_computer_agent_observations"
INSERT INTO `new_computer_agent_observations` (`id`, `server_id`, `computer_id`, `agent_id`, `assignment_epoch`, `assignment_revision`, `config_generation`, `attempt`, `sequence`, `launch_id`, `state`, `error_code`, `request_hash`, `observed_at`, `created_at`) SELECT `id`, `server_id`, `computer_id`, `agent_id`, `assignment_epoch`, `assignment_revision`, `config_generation`, `attempt`, `sequence`, `launch_id`, `state`, `error_code`, `request_hash`, `observed_at`, `created_at` FROM `computer_agent_observations`;
-- Drop "computer_agent_observations" table after copying rows
DROP TABLE `computer_agent_observations`;
-- Rename temporary table "new_computer_agent_observations" to "computer_agent_observations"
ALTER TABLE `new_computer_agent_observations` RENAME TO `computer_agent_observations`;
-- Create index "computeragentobservation_server_id_id" to table: "computer_agent_observations"
CREATE UNIQUE INDEX `computeragentobservation_server_id_id` ON `computer_agent_observations` (`server_id`, `id`);
-- Create index "computeragentobservation_server_5ed3cf191ed056e4f6ff20dfa0efb754" to table: "computer_agent_observations"
CREATE INDEX `computeragentobservation_server_5ed3cf191ed056e4f6ff20dfa0efb754` ON `computer_agent_observations` (`server_id`, `agent_id`, `config_generation`, `attempt`, `sequence`);
-- Create index "computeragentobservation_server_id_computer_id_created_at_id" to table: "computer_agent_observations"
CREATE INDEX `computeragentobservation_server_id_computer_id_created_at_id` ON `computer_agent_observations` (`server_id`, `computer_id`, `created_at`, `id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
