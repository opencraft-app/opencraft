-- Create "bot_agents" table
CREATE TABLE `bot_agents` (`id` text NOT NULL, `account_id` text NOT NULL, `instance_id` text NOT NULL, `bot_id` text NOT NULL, `display_name` text NOT NULL, `im_user_id` text NOT NULL, `state` text NOT NULL, `last_error_code` text NULL, `command_policy` text NOT NULL, `credential_version` integer NOT NULL, `credential_digest` blob NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "botagent_account_id_instance_id_bot_id" to table: "bot_agents"
CREATE UNIQUE INDEX `botagent_account_id_instance_id_bot_id` ON `bot_agents` (`account_id`, `instance_id`, `bot_id`);
-- Create index "botagent_account_id_state_id" to table: "bot_agents"
CREATE INDEX `botagent_account_id_state_id` ON `bot_agents` (`account_id`, `state`, `id`);
-- Create "im_groups" table
CREATE TABLE `im_groups` (`id` text NOT NULL, `tencent_group_id` text NOT NULL, `owner_account_id` text NOT NULL, `created_by_im_user_id` text NOT NULL, `name` text NOT NULL, `reply_mode` text NOT NULL, `state` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create "im_group_members" table
CREATE TABLE `im_group_members` (`id` text NOT NULL, `group_id` text NOT NULL, `im_user_id` text NOT NULL, `kind` text NOT NULL, `role` text NOT NULL, `state` text NOT NULL, `added_by_im_user_id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "imgroupmember_group_id_im_user_id" to table: "im_group_members"
CREATE UNIQUE INDEX `imgroupmember_group_id_im_user_id` ON `im_group_members` (`group_id`, `im_user_id`);
-- Create index "imgroupmember_group_id_state_id" to table: "im_group_members"
CREATE INDEX `imgroupmember_group_id_state_id` ON `im_group_members` (`group_id`, `state`, `id`);
-- Create "im_identity_routes" table
CREATE TABLE `im_identity_routes` (`id` text NOT NULL, `im_user_id` text NOT NULL, `kind` text NOT NULL, `account_id` text NOT NULL, `bot_agent_id` text NULL, `restricted_at` datetime NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "imidentityroute_im_user_id" to table: "im_identity_routes"
CREATE UNIQUE INDEX `imidentityroute_im_user_id` ON `im_identity_routes` (`im_user_id`);
