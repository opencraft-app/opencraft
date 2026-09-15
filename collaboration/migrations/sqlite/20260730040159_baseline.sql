-- Create "accounts" table
CREATE TABLE `accounts` (`id` text NOT NULL, `email` text NOT NULL, `email_normalized` text NOT NULL, `display_name` text NOT NULL, `password_hash` text NOT NULL, `token_version` integer NOT NULL, `im_user_id` text NOT NULL, `im_state` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "account_id_im_state" to table: "accounts"
CREATE INDEX `account_id_im_state` ON `accounts` (`id`, `im_state`);
-- Create "account_login_identities" table
CREATE TABLE `account_login_identities` (`id` text NOT NULL, `login_hash` text NOT NULL, `kind` text NOT NULL, `normalized_login` text NOT NULL, `account_id` text NOT NULL, `state` text NOT NULL, `created_at` datetime NOT NULL, `retired_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "accountloginidentity_login_hash_kind" to table: "account_login_identities"
CREATE UNIQUE INDEX `accountloginidentity_login_hash_kind` ON `account_login_identities` (`login_hash`, `kind`);
-- Create index "accountloginidentity_login_hash_account_id" to table: "account_login_identities"
CREATE INDEX `accountloginidentity_login_hash_account_id` ON `account_login_identities` (`login_hash`, `account_id`);
-- Create "account_server_memberships" table
CREATE TABLE `account_server_memberships` (`id` text NOT NULL, `account_id` text NOT NULL, `server_id` text NOT NULL, `member_id` text NOT NULL, `role` text NOT NULL, `status` text NOT NULL, `server_name_snapshot` text NOT NULL, `server_slug_snapshot` text NOT NULL, `server_revision` integer NOT NULL, `projected_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "accountservermembership_account_id_server_id" to table: "account_server_memberships"
CREATE UNIQUE INDEX `accountservermembership_account_id_server_id` ON `account_server_memberships` (`account_id`, `server_id`);
-- Create index "accountservermembership_account_id_status_updated_at_server_id" to table: "account_server_memberships"
CREATE INDEX `accountservermembership_account_id_status_updated_at_server_id` ON `account_server_memberships` (`account_id`, `status`, `updated_at`, `server_id`);
-- Create "agents" table
CREATE TABLE `agents` (`id` text NOT NULL, `server_id` text NOT NULL, `im_user_id` text NOT NULL, `computer_id` text NULL, `description` text NULL, `runtime_kind` text NOT NULL, `runtime_model` text NULL, `reply_policy` text NOT NULL, `desired_state` text NOT NULL, `observed_state` text NOT NULL, `credential_version` integer NOT NULL, `im_state` text NOT NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `created_by_member_id` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "agent_server_id_im_user_id" to table: "agents"
CREATE UNIQUE INDEX `agent_server_id_im_user_id` ON `agents` (`server_id`, `im_user_id`);
-- Create index "agent_server_id_computer_id_observed_state_id" to table: "agents"
CREATE INDEX `agent_server_id_computer_id_observed_state_id` ON `agents` (`server_id`, `computer_id`, `observed_state`, `id`);
-- Create "agent_runtime_credentials" table
CREATE TABLE `agent_runtime_credentials` (`id` text NOT NULL, `server_id` text NOT NULL, `agent_id` text NOT NULL, `version` integer NOT NULL, `secret_hash` blob NOT NULL, `state` text NOT NULL, `last_used_at` datetime NULL, `created_at` datetime NOT NULL, `revoked_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "agentruntimecredential_server_id_agent_id_version" to table: "agent_runtime_credentials"
CREATE UNIQUE INDEX `agentruntimecredential_server_id_agent_id_version` ON `agent_runtime_credentials` (`server_id`, `agent_id`, `version`);
-- Create index "agentruntimecredential_server_id_secret_hash" to table: "agent_runtime_credentials"
CREATE UNIQUE INDEX `agentruntimecredential_server_id_secret_hash` ON `agent_runtime_credentials` (`server_id`, `secret_hash`);
-- Create index "agentruntimecredential_server_id_agent_id_state_version" to table: "agent_runtime_credentials"
CREATE INDEX `agentruntimecredential_server_id_agent_id_state_version` ON `agent_runtime_credentials` (`server_id`, `agent_id`, `state`, `version`);
-- Create "auth_sessions" table
CREATE TABLE `auth_sessions` (`id` text NOT NULL, `account_id` text NOT NULL, `family_id` text NOT NULL, `refresh_token_hash` blob NOT NULL, `expires_at` datetime NOT NULL, `used_at` datetime NULL, `revoked_at` datetime NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "authsession_account_id_refresh_token_hash" to table: "auth_sessions"
CREATE UNIQUE INDEX `authsession_account_id_refresh_token_hash` ON `auth_sessions` (`account_id`, `refresh_token_hash`);
-- Create index "authsession_account_id_family_id" to table: "auth_sessions"
CREATE INDEX `authsession_account_id_family_id` ON `auth_sessions` (`account_id`, `family_id`);
-- Create index "authsession_account_id_expires_at" to table: "auth_sessions"
CREATE INDEX `authsession_account_id_expires_at` ON `auth_sessions` (`account_id`, `expires_at`);
-- Create "channels" table
CREATE TABLE `channels` (`id` text NOT NULL, `server_id` text NOT NULL, `name` text NOT NULL, `description` text NULL, `visibility` text NOT NULL, `system_key` text NULL, `im_group_id` text NOT NULL, `im_topic_id` text NULL, `im_state` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "channel_server_id_name" to table: "channels"
CREATE UNIQUE INDEX `channel_server_id_name` ON `channels` (`server_id`, `name`);
-- Create index "channel_server_id_system_key" to table: "channels"
CREATE UNIQUE INDEX `channel_server_id_system_key` ON `channels` (`server_id`, `system_key`);
-- Create index "channel_server_id_im_group_id_im_topic_id" to table: "channels"
CREATE UNIQUE INDEX `channel_server_id_im_group_id_im_topic_id` ON `channels` (`server_id`, `im_group_id`, `im_topic_id`);
-- Create index "channel_server_id_im_state_id" to table: "channels"
CREATE INDEX `channel_server_id_im_state_id` ON `channels` (`server_id`, `im_state`, `id`);
-- Create "channel_members" table
CREATE TABLE `channel_members` (`id` text NOT NULL, `server_id` text NOT NULL, `channel_id` text NOT NULL, `member_id` text NOT NULL, `state` text NOT NULL, `im_state` text NOT NULL, `membership_version` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "channelmember_server_id_channel_id_member_id" to table: "channel_members"
CREATE UNIQUE INDEX `channelmember_server_id_channel_id_member_id` ON `channel_members` (`server_id`, `channel_id`, `member_id`);
-- Create index "channelmember_server_id_member_id_state_channel_id" to table: "channel_members"
CREATE INDEX `channelmember_server_id_member_id_state_channel_id` ON `channel_members` (`server_id`, `member_id`, `state`, `channel_id`);
-- Create index "channelmember_server_id_channel_id_state_member_id" to table: "channel_members"
CREATE INDEX `channelmember_server_id_channel_id_state_member_id` ON `channel_members` (`server_id`, `channel_id`, `state`, `member_id`);
-- Create "computers" table
CREATE TABLE `computers` (`id` text NOT NULL, `server_id` text NOT NULL, `name` text NOT NULL, `tat_region` text NOT NULL, `tat_instance_id` text NULL, `tat_instance_kind` text NOT NULL, `os_type` text NOT NULL, `lifecycle_state` text NOT NULL, `tat_agent_state` text NOT NULL, `registration_expires_at` datetime NULL, `last_observed_at` datetime NULL, `last_error_code` text NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "computer_server_id_name" to table: "computers"
CREATE UNIQUE INDEX `computer_server_id_name` ON `computers` (`server_id`, `name`);
-- Create index "computer_server_id_tat_region_tat_instance_id" to table: "computers"
CREATE UNIQUE INDEX `computer_server_id_tat_region_tat_instance_id` ON `computers` (`server_id`, `tat_region`, `tat_instance_id`);
-- Create index "computer_server_id_lifecycle_state_id" to table: "computers"
CREATE INDEX `computer_server_id_lifecycle_state_id` ON `computers` (`server_id`, `lifecycle_state`, `id`);
-- Create index "computer_server_id_tat_agent_state_last_observed_at" to table: "computers"
CREATE INDEX `computer_server_id_tat_agent_state_last_observed_at` ON `computers` (`server_id`, `tat_agent_state`, `last_observed_at`);
-- Create "idempotency_records" table
CREATE TABLE `idempotency_records` (`id` text NOT NULL, `partition_key` text NOT NULL, `scope_type` text NOT NULL, `scope_id` text NOT NULL, `idempotency_key` text NOT NULL, `request_hash` blob NOT NULL, `response_status` integer NOT NULL, `response_body_json` text NOT NULL, `expires_at` datetime NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "idempotencyrecord_partition_key_ee1782db4f75ced3502600418e82f683" to table: "idempotency_records"
CREATE UNIQUE INDEX `idempotencyrecord_partition_key_ee1782db4f75ced3502600418e82f683` ON `idempotency_records` (`partition_key`, `scope_type`, `scope_id`, `idempotency_key`);
-- Create index "idempotencyrecord_partition_key_expires_at_id" to table: "idempotency_records"
CREATE INDEX `idempotencyrecord_partition_key_expires_at_id` ON `idempotency_records` (`partition_key`, `expires_at`, `id`);
-- Create "members" table
CREATE TABLE `members` (`id` text NOT NULL, `server_id` text NOT NULL, `account_id` text NULL, `kind` text NOT NULL, `role` text NOT NULL, `display_name` text NOT NULL, `handle` text NOT NULL, `status` text NOT NULL, `im_state` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "member_server_id_handle" to table: "members"
CREATE UNIQUE INDEX `member_server_id_handle` ON `members` (`server_id`, `handle`);
-- Create index "member_server_id_account_id" to table: "members"
CREATE UNIQUE INDEX `member_server_id_account_id` ON `members` (`server_id`, `account_id`);
-- Create index "member_server_id_status_id" to table: "members"
CREATE INDEX `member_server_id_status_id` ON `members` (`server_id`, `status`, `id`);
-- Create "outbox_events" table
CREATE TABLE `outbox_events` (`id` text NOT NULL, `partition_key` text NOT NULL, `server_id` text NULL, `event_type` text NOT NULL, `aggregate_type` text NOT NULL, `aggregate_id` text NOT NULL, `state` text NOT NULL, `attempts` integer NOT NULL, `available_at` datetime NOT NULL, `lease_owner` text NULL, `lease_expires_at` datetime NULL, `last_error_code` text NULL, `created_at` datetime NOT NULL, `processed_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "outboxevent_partition_key_state_available_at_id" to table: "outbox_events"
CREATE INDEX `outboxevent_partition_key_state_available_at_id` ON `outbox_events` (`partition_key`, `state`, `available_at`, `id`);
-- Create index "outboxevent_partition_key_aggregate_type_aggregate_id_id" to table: "outbox_events"
CREATE INDEX `outboxevent_partition_key_aggregate_type_aggregate_id_id` ON `outbox_events` (`partition_key`, `aggregate_type`, `aggregate_id`, `id`);
-- Create "reminders" table
CREATE TABLE `reminders` (`id` text NOT NULL, `server_id` text NOT NULL, `agent_id` text NOT NULL, `created_by_member_id` text NOT NULL, `schedule_kind` text NOT NULL, `schedule` text NOT NULL, `timezone` text NOT NULL, `text` text NOT NULL, `status` text NOT NULL, `next_fire_at` datetime NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "reminder_server_id_agent_id_status_id" to table: "reminders"
CREATE INDEX `reminder_server_id_agent_id_status_id` ON `reminders` (`server_id`, `agent_id`, `status`, `id`);
-- Create index "reminder_server_id_status_next_fire_at_id" to table: "reminders"
CREATE INDEX `reminder_server_id_status_next_fire_at_id` ON `reminders` (`server_id`, `status`, `next_fire_at`, `id`);
-- Create "reminder_occurrences" table
CREATE TABLE `reminder_occurrences` (`id` text NOT NULL, `server_id` text NOT NULL, `reminder_id` text NOT NULL, `agent_id` text NOT NULL, `scheduled_fire_at` datetime NOT NULL, `state` text NOT NULL, `acknowledged_at` datetime NULL, `result_code` text NULL, `text_snapshot` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "reminderoccurrence_server_id_reminder_id_scheduled_fire_at" to table: "reminder_occurrences"
CREATE UNIQUE INDEX `reminderoccurrence_server_id_reminder_id_scheduled_fire_at` ON `reminder_occurrences` (`server_id`, `reminder_id`, `scheduled_fire_at`);
-- Create index "reminderoccurrence_server_id_agent_id_state_scheduled_fire_at_id" to table: "reminder_occurrences"
CREATE INDEX `reminderoccurrence_server_id_agent_id_state_scheduled_fire_at_id` ON `reminder_occurrences` (`server_id`, `agent_id`, `state`, `scheduled_fire_at`, `id`);
-- Create "servers" table
CREATE TABLE `servers` (`id` text NOT NULL, `slug` text NOT NULL, `name` text NOT NULL, `description` text NULL, `owner_member_id` text NULL, `im_group_id` text NOT NULL, `im_state` text NOT NULL, `next_task_number` integer NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "server_id_im_state" to table: "servers"
CREATE INDEX `server_id_im_state` ON `servers` (`id`, `im_state`);
-- Create index "server_id_owner_member_id" to table: "servers"
CREATE INDEX `server_id_owner_member_id` ON `servers` (`id`, `owner_member_id`);
-- Create "server_invites" table
CREATE TABLE `server_invites` (`id` text NOT NULL, `server_id` text NOT NULL, `token_hash` blob NOT NULL, `role` text NOT NULL, `max_uses` integer NOT NULL, `used_count` integer NOT NULL, `expires_at` datetime NOT NULL, `revoked_at` datetime NULL, `created_by_member_id` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "serverinvite_server_id_token_hash" to table: "server_invites"
CREATE UNIQUE INDEX `serverinvite_server_id_token_hash` ON `server_invites` (`server_id`, `token_hash`);
-- Create index "serverinvite_server_id_expires_at_id" to table: "server_invites"
CREATE INDEX `serverinvite_server_id_expires_at_id` ON `server_invites` (`server_id`, `expires_at`, `id`);
-- Create "server_slug_registry" table
CREATE TABLE `server_slug_registry` (`id` text NOT NULL, `slug` text NOT NULL, `server_id` text NOT NULL, `state` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "serverslugregistry_slug" to table: "server_slug_registry"
CREATE UNIQUE INDEX `serverslugregistry_slug` ON `server_slug_registry` (`slug`);
-- Create index "serverslugregistry_slug_server_id" to table: "server_slug_registry"
CREATE INDEX `serverslugregistry_slug_server_id` ON `server_slug_registry` (`slug`, `server_id`);
-- Create "tat_instance_bindings" table
CREATE TABLE `tat_instance_bindings` (`id` text NOT NULL, `binding_hash` text NOT NULL, `tat_region` text NOT NULL, `tat_instance_id` text NOT NULL, `server_id` text NOT NULL, `computer_id` text NOT NULL, `state` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "tatinstancebinding_binding_hash" to table: "tat_instance_bindings"
CREATE UNIQUE INDEX `tatinstancebinding_binding_hash` ON `tat_instance_bindings` (`binding_hash`);
-- Create index "tatinstancebinding_binding_hash_server_id_computer_id" to table: "tat_instance_bindings"
CREATE INDEX `tatinstancebinding_binding_hash_server_id_computer_id` ON `tat_instance_bindings` (`binding_hash`, `server_id`, `computer_id`);
-- Create "tasks" table
CREATE TABLE `tasks` (`id` text NOT NULL, `server_id` text NOT NULL, `number` integer NOT NULL, `title` text NOT NULL, `description` text NULL, `status` text NOT NULL, `owner_member_id` text NULL, `assignment_revision` integer NOT NULL, `created_by_member_id` text NOT NULL, `updated_by_member_id` text NOT NULL, `source_message_ref_json` text NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "task_server_id_number" to table: "tasks"
CREATE UNIQUE INDEX `task_server_id_number` ON `tasks` (`server_id`, `number`);
-- Create index "task_server_id_owner_member_id_status_id" to table: "tasks"
CREATE INDEX `task_server_id_owner_member_id_status_id` ON `tasks` (`server_id`, `owner_member_id`, `status`, `id`);
-- Create index "task_server_id_status_updated_at_id" to table: "tasks"
CREATE INDEX `task_server_id_status_updated_at_id` ON `tasks` (`server_id`, `status`, `updated_at`, `id`);
-- Create "tencent_operations" table
CREATE TABLE `tencent_operations` (`id` text NOT NULL, `partition_key` text NOT NULL, `server_id` text NULL, `service` text NOT NULL, `kind` text NOT NULL, `resource_type` text NOT NULL, `resource_id` text NOT NULL, `idempotency_key` text NOT NULL, `desired_revision` integer NULL, `request_snapshot_json` text NULL, `state` text NOT NULL, `attempts` integer NOT NULL, `next_attempt_at` datetime NULL, `lease_owner` text NULL, `lease_expires_at` datetime NULL, `deadline_at` datetime NULL, `last_error_code` text NULL, `result_json` text NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `completed_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "tencentoperation_partition_key_service_idempotency_key" to table: "tencent_operations"
CREATE UNIQUE INDEX `tencentoperation_partition_key_service_idempotency_key` ON `tencent_operations` (`partition_key`, `service`, `idempotency_key`);
-- Create index "tencentoperation_partition_key_state_next_attempt_at_id" to table: "tencent_operations"
CREATE INDEX `tencentoperation_partition_key_state_next_attempt_at_id` ON `tencent_operations` (`partition_key`, `state`, `next_attempt_at`, `id`);
-- Create index "tencentoperation_partition_key__2f9f4e40d3be0a4c38d6ab0acddb8f04" to table: "tencent_operations"
CREATE INDEX `tencentoperation_partition_key__2f9f4e40d3be0a4c38d6ab0acddb8f04` ON `tencent_operations` (`partition_key`, `resource_type`, `resource_id`, `desired_revision`);
