-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_computers" table
CREATE TABLE `new_computers` (`id` text NOT NULL, `server_id` text NOT NULL, `name` text NOT NULL, `tat_region` text NOT NULL, `tat_instance_id` text NULL, `tat_instance_kind` text NOT NULL, `os_type` text NOT NULL, `lifecycle_state` text NOT NULL, `tat_agent_state` text NOT NULL, `registration_expires_at` datetime NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `assignment_epoch` text NOT NULL, `assignment_revision` integer NOT NULL, `host_last_seen_at` datetime NULL, `daemon_version` text NULL, `daemon_version_token_issued_at` datetime NULL, `last_reconcile_error_code` text NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "computers" to new temporary table "new_computers"
INSERT INTO `new_computers` (`id`, `server_id`, `name`, `tat_region`, `tat_instance_id`, `tat_instance_kind`, `os_type`, `lifecycle_state`, `tat_agent_state`, `registration_expires_at`, `last_observed_at`, `last_error_code`, `assignment_epoch`, `assignment_revision`, `revision`, `created_at`, `updated_at`) SELECT `id`, `server_id`, `name`, `tat_region`, `tat_instance_id`, `tat_instance_kind`, `os_type`, `lifecycle_state`, `tat_agent_state`, `registration_expires_at`, `last_observed_at`, `last_error_code`, `id`, 1, `revision`, `created_at`, `updated_at` FROM `computers`;
-- Drop "computers" table after copying rows
DROP TABLE `computers`;
-- Rename temporary table "new_computers" to "computers"
ALTER TABLE `new_computers` RENAME TO `computers`;
-- Create index "computer_server_id_name" to table: "computers"
CREATE UNIQUE INDEX `computer_server_id_name` ON `computers` (`server_id`, `name`);
-- Create index "computer_server_id_tat_region_tat_instance_id" to table: "computers"
CREATE UNIQUE INDEX `computer_server_id_tat_region_tat_instance_id` ON `computers` (`server_id`, `tat_region`, `tat_instance_id`);
-- Create index "computer_server_id_lifecycle_state_id" to table: "computers"
CREATE INDEX `computer_server_id_lifecycle_state_id` ON `computers` (`server_id`, `lifecycle_state`, `id`);
-- Create index "computer_server_id_tat_agent_state_last_observed_at" to table: "computers"
CREATE INDEX `computer_server_id_tat_agent_state_last_observed_at` ON `computers` (`server_id`, `tat_agent_state`, `last_observed_at`);
-- Create "new_agents" table
CREATE TABLE `new_agents` (`id` text NOT NULL, `server_id` text NOT NULL, `im_user_id` text NOT NULL, `computer_id` text NULL, `description` text NULL, `runtime_kind` text NOT NULL, `runtime_model` text NULL, `reply_policy` text NOT NULL, `desired_state` text NOT NULL, `observed_state` text NOT NULL, `credential_version` integer NOT NULL, `im_state` text NOT NULL, `im_presence` text NOT NULL, `im_presence_updated_at` datetime NULL, `host_last_seen_at` datetime NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `observed_assignment_epoch` text NULL, `observed_generation` integer NOT NULL, `observed_attempt` integer NOT NULL, `observed_sequence` integer NOT NULL, `observed_launch_id` text NULL, `created_by_member_id` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "agents" to new temporary table "new_agents"
INSERT INTO `new_agents` (`id`, `server_id`, `im_user_id`, `computer_id`, `description`, `runtime_kind`, `runtime_model`, `reply_policy`, `desired_state`, `observed_state`, `credential_version`, `im_state`, `im_presence`, `im_presence_updated_at`, `host_last_seen_at`, `last_observed_at`, `last_error_code`, `observed_generation`, `observed_attempt`, `observed_sequence`, `created_by_member_id`, `revision`, `created_at`, `updated_at`) SELECT `id`, `server_id`, `im_user_id`, `computer_id`, `description`, `runtime_kind`, `runtime_model`, `reply_policy`, `desired_state`, `observed_state`, `credential_version`, `im_state`, `im_presence`, `im_presence_updated_at`, `host_last_seen_at`, `last_observed_at`, `last_error_code`, 0, 0, 0, `created_by_member_id`, `revision`, `created_at`, `updated_at` FROM `agents`;
-- Drop "agents" table after copying rows
DROP TABLE `agents`;
-- Rename temporary table "new_agents" to "agents"
ALTER TABLE `new_agents` RENAME TO `agents`;
-- Create index "agent_server_id_im_user_id" to table: "agents"
CREATE UNIQUE INDEX `agent_server_id_im_user_id` ON `agents` (`server_id`, `im_user_id`);
-- Create index "agent_server_id_computer_id_observed_state_id" to table: "agents"
CREATE INDEX `agent_server_id_computer_id_observed_state_id` ON `agents` (`server_id`, `computer_id`, `observed_state`, `id`);
-- Create index "agent_server_id_desired_state_o_44fc0d6aff8b556b9c81b7af7429dd55" to table: "agents"
CREATE INDEX `agent_server_id_desired_state_o_44fc0d6aff8b556b9c81b7af7429dd55` ON `agents` (`server_id`, `desired_state`, `observed_state`, `im_state`, `last_observed_at`, `id`);
-- Create "computer_agent_observations" table
CREATE TABLE `computer_agent_observations` (`id` text NOT NULL, `server_id` text NOT NULL, `computer_id` text NOT NULL, `agent_id` text NOT NULL, `assignment_epoch` text NOT NULL, `assignment_revision` integer NOT NULL, `config_generation` integer NOT NULL, `attempt` integer NOT NULL, `sequence` integer NOT NULL, `launch_id` text NOT NULL, `state` text NOT NULL, `error_code` text NULL, `request_hash` blob NOT NULL, `observed_at` datetime NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "computeragentobservation_server_id_id" to table: "computer_agent_observations"
CREATE UNIQUE INDEX `computeragentobservation_server_id_id` ON `computer_agent_observations` (`server_id`, `id`);
-- Create index "computeragentobservation_server_5ed3cf191ed056e4f6ff20dfa0efb754" to table: "computer_agent_observations"
CREATE INDEX `computeragentobservation_server_5ed3cf191ed056e4f6ff20dfa0efb754` ON `computer_agent_observations` (`server_id`, `agent_id`, `config_generation`, `attempt`, `sequence`);
-- Create index "computeragentobservation_server_id_computer_id_created_at_id" to table: "computer_agent_observations"
CREATE INDEX `computeragentobservation_server_id_computer_id_created_at_id` ON `computer_agent_observations` (`server_id`, `computer_id`, `created_at`, `id`);
-- Create "computer_runtime_credentials" table
CREATE TABLE `computer_runtime_credentials` (`id` text NOT NULL, `server_id` text NOT NULL, `computer_id` text NOT NULL, `version` integer NOT NULL, `secret_hash` blob NOT NULL, `state` text NOT NULL, `expires_at` datetime NOT NULL, `grace_expires_at` datetime NULL, `last_used_at` datetime NULL, `revoked_at` datetime NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "computerruntimecredential_server_id_computer_id_version" to table: "computer_runtime_credentials"
CREATE UNIQUE INDEX `computerruntimecredential_server_id_computer_id_version` ON `computer_runtime_credentials` (`server_id`, `computer_id`, `version`);
-- Create index "computerruntimecredential_server_id_secret_hash" to table: "computer_runtime_credentials"
CREATE UNIQUE INDEX `computerruntimecredential_server_id_secret_hash` ON `computer_runtime_credentials` (`server_id`, `secret_hash`);
-- Create index "computerruntimecredential_server_id_computer_id_state_version" to table: "computer_runtime_credentials"
CREATE INDEX `computerruntimecredential_server_id_computer_id_state_version` ON `computer_runtime_credentials` (`server_id`, `computer_id`, `state`, `version`);
-- Create index "computerruntimecredential_server_id_expires_at_id" to table: "computer_runtime_credentials"
CREATE INDEX `computerruntimecredential_server_id_expires_at_id` ON `computer_runtime_credentials` (`server_id`, `expires_at`, `id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
