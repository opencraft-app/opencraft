-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_computers" table
CREATE TABLE `new_computers` (`id` text NOT NULL, `server_id` text NOT NULL, `name` text NOT NULL, `tat_region` text NOT NULL, `tat_instance_id` text NULL, `tat_instance_kind` text NOT NULL, `os_type` text NOT NULL, `lifecycle_state` text NOT NULL, `tat_agent_state` text NOT NULL, `registration_expires_at` datetime NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `assignment_epoch` text NOT NULL, `assignment_revision` integer NOT NULL, `host_last_seen_at` datetime NULL, `daemon_version` text NULL, `daemon_build_id` text NULL, `daemon_version_token_issued_at` datetime NULL, `last_reconcile_error_code` text NULL, `enrollment_generation` integer NOT NULL DEFAULT (0), `enrollment_token_hash` blob NULL, `enrollment_expires_at` datetime NULL, `enrollment_claimed_at` datetime NULL, `enrollment_credential_version` integer NULL, `enrollment_release_version` text NULL, `enrollment_target` text NULL, `enrollment_architecture` text NULL, `enrollment_manifest_object` text NULL, `enrollment_manifest_sha256` blob NULL, `enrollment_signature_object` text NULL, `enrollment_signature_sha256` blob NULL, `enrollment_installer_object` text NULL, `enrollment_installer_sha256` blob NULL, `enrollment_signing_key_id` text NULL, `enrollment_program_object` text NULL, `enrollment_program_sha256` blob NULL, `enrollment_program_size` integer NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "computers" to new temporary table "new_computers"
INSERT INTO `new_computers` (`id`, `server_id`, `name`, `tat_region`, `tat_instance_id`, `tat_instance_kind`, `os_type`, `lifecycle_state`, `tat_agent_state`, `registration_expires_at`, `last_observed_at`, `last_error_code`, `assignment_epoch`, `assignment_revision`, `host_last_seen_at`, `daemon_version`, `daemon_build_id`, `daemon_version_token_issued_at`, `last_reconcile_error_code`, `revision`, `created_at`, `updated_at`) SELECT `id`, `server_id`, `name`, `tat_region`, `tat_instance_id`, `tat_instance_kind`, `os_type`, `lifecycle_state`, `tat_agent_state`, `registration_expires_at`, `last_observed_at`, `last_error_code`, `assignment_epoch`, `assignment_revision`, `host_last_seen_at`, `daemon_version`, `daemon_build_id`, `daemon_version_token_issued_at`, `last_reconcile_error_code`, `revision`, `created_at`, `updated_at` FROM `computers`;
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
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
