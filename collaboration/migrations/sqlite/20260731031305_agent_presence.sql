-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_agents" table
CREATE TABLE `new_agents` (`id` text NOT NULL, `server_id` text NOT NULL, `im_user_id` text NOT NULL, `computer_id` text NULL, `description` text NULL, `runtime_kind` text NOT NULL, `runtime_model` text NULL, `reply_policy` text NOT NULL, `desired_state` text NOT NULL, `observed_state` text NOT NULL, `credential_version` integer NOT NULL, `im_state` text NOT NULL, `im_presence` text NOT NULL, `im_presence_updated_at` datetime NULL, `host_last_seen_at` datetime NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `created_by_member_id` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "agents" to new temporary table "new_agents"
INSERT INTO `new_agents` (`id`, `server_id`, `im_user_id`, `computer_id`, `description`, `runtime_kind`, `runtime_model`, `reply_policy`, `desired_state`, `observed_state`, `credential_version`, `im_state`, `im_presence`, `last_observed_at`, `last_error_code`, `created_by_member_id`, `revision`, `created_at`, `updated_at`) SELECT `id`, `server_id`, `im_user_id`, `computer_id`, `description`, `runtime_kind`, `runtime_model`, `reply_policy`, `desired_state`, `observed_state`, `credential_version`, `im_state`, 'unknown', `last_observed_at`, `last_error_code`, `created_by_member_id`, `revision`, `created_at`, `updated_at` FROM `agents`;
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
-- Create "agent_im_routes" table
CREATE TABLE `agent_im_routes` (`id` text NOT NULL, `im_user_id` text NOT NULL, `server_id` text NOT NULL, `agent_id` text NOT NULL, `state` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Backfill global IM routes for Agents created before this projection existed.
INSERT INTO `agent_im_routes` (`id`, `im_user_id`, `server_id`, `agent_id`, `state`, `created_at`, `updated_at`)
SELECT `id`, `im_user_id`, `server_id`, `id`, 'active', `created_at`, `updated_at`
FROM `agents`;
-- Reuse the latest authenticated Runtime Session as the initial host lease fact.
UPDATE `agents`
SET `host_last_seen_at` = (
  SELECT MAX(`last_used_at`)
  FROM `agent_runtime_credentials`
  WHERE `agent_runtime_credentials`.`server_id` = `agents`.`server_id`
    AND `agent_runtime_credentials`.`agent_id` = `agents`.`id`
    AND `agent_runtime_credentials`.`state` = 'active'
    AND `agent_runtime_credentials`.`revoked_at` IS NULL
)
WHERE EXISTS (
  SELECT 1
  FROM `agent_runtime_credentials`
  WHERE `agent_runtime_credentials`.`server_id` = `agents`.`server_id`
    AND `agent_runtime_credentials`.`agent_id` = `agents`.`id`
    AND `agent_runtime_credentials`.`state` = 'active'
    AND `agent_runtime_credentials`.`revoked_at` IS NULL
    AND `agent_runtime_credentials`.`last_used_at` IS NOT NULL
);
-- Create index "agentimroute_im_user_id" to table: "agent_im_routes"
CREATE UNIQUE INDEX `agentimroute_im_user_id` ON `agent_im_routes` (`im_user_id`);
-- Create index "agentimroute_server_id_agent_id" to table: "agent_im_routes"
CREATE INDEX `agentimroute_server_id_agent_id` ON `agent_im_routes` (`server_id`, `agent_id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
