CREATE TABLE `actor_channel_attachments` (
	`message_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` blob NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_changes` (
	`revision` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channel_changes_message_id_unique` ON `actor_channel_changes` (`message_id`);--> statement-breakpoint
CREATE INDEX `actor_channel_changes_by_channel` ON `actor_channel_changes` (`channel_id`,`revision`);--> statement-breakpoint
CREATE TABLE `actor_channel_departures` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`member_epoch` text NOT NULL,
	`left_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_execution_membership` (
	`request_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`requester_epoch` text NOT NULL,
	`target_epoch` text NOT NULL,
	PRIMARY KEY(`request_id`, `channel_id`),
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_external_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channel_external_identity` ON `actor_channel_external_messages` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `actor_channel_identity` (
	`epoch` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_images` (
	`message_id` text PRIMARY KEY NOT NULL,
	`source` text,
	`media_id` text,
	`mime` text,
	`bytes` blob,
	`state` text NOT NULL,
	`attribution` text,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_lifecycles` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`dissolved_at` integer,
	`dissolved_by` text,
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_channel_lifecycles_revision" CHECK("actor_channel_lifecycles"."revision" >= 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_list_states` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_channel_list_hidden" CHECK("actor_channel_list_states"."hidden" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_members` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`epoch` text NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_channel_members_actor` ON `actor_channel_members` (`actor_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `actor_channel_mention_reads` (
	`message_id` text NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `actor_id`),
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_mentions` (
	`message_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`display_name` text NOT NULL,
	`actor_kind` text NOT NULL,
	PRIMARY KEY(`message_id`, `start`),
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_channel_mentions_range" CHECK(start >= 0 AND end > start),
	CONSTRAINT "actor_channel_mentions_kind" CHECK(actor_kind IN ('human','session'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_channel_mentions_receiver` ON `actor_channel_mentions` (`actor_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `actor_channel_outbox` (
	`message_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_epoch` text NOT NULL,
	`actor_generation` integer NOT NULL,
	`member_epoch` text NOT NULL,
	`credential_id` text,
	`actor_expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_channel_outbox_pending` ON `actor_channel_outbox` (`state`,`source`);--> statement-breakpoint
CREATE TABLE `actor_channel_reads` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`epoch` text NOT NULL,
	`joined_seq` integer NOT NULL,
	`read_seq` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`epoch` text NOT NULL,
	`incarnation` text NOT NULL,
	`active` integer NOT NULL,
	`images` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channel_sources_channel` ON `actor_channel_sources` (`channel_id`);--> statement-breakpoint
CREATE TABLE `actor_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`peer_id` text,
	`title` text,
	`create_key` text,
	`create_fingerprint` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channels_owner_id_create_key_unique` ON `actor_channels` (`owner_id`,`create_key`);--> statement-breakpoint
CREATE INDEX `actor_channels_peer` ON `actor_channels` (`peer_id`);--> statement-breakpoint
CREATE TABLE `actor_human_reservations` (
	`binding` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`login_provider` text NOT NULL,
	`alias` text NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_human_reservations_state" CHECK(state IN ('pending','claimed','revoked'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_human_reservations_alias` ON `actor_human_reservations` (`login_provider`,`alias`,`state`);--> statement-breakpoint
CREATE TABLE `actor_inbox_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "actor_inbox_clock_singleton" CHECK(id = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_inbox_rows` (
	`actor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text,
	PRIMARY KEY(`actor_id`, `channel_id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_inbox_changes` ON `actor_inbox_rows` (`actor_id`,`revision`);--> statement-breakpoint
CREATE TABLE `assistant_thread_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`epoch` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`work_id` text,
	`profile_id` text NOT NULL,
	`profile_revision` integer NOT NULL,
	`state` text NOT NULL,
	`reference` text,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_thread_operation_key` ON `assistant_thread_operations` (`bot_id`,`epoch`,`request_key`);--> statement-breakpoint
CREATE INDEX `assistant_thread_owned_page` ON `assistant_thread_operations` (`bot_id`,`epoch`,`command`,`id`);--> statement-breakpoint
CREATE INDEX `assistant_thread_target` ON `assistant_thread_operations` (`bot_id`,`epoch`,`reference`,`command`);--> statement-breakpoint
CREATE TABLE `assistant_thread_profiles` (
	`bot_id` text NOT NULL,
	`id` text NOT NULL,
	`epoch` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`settings` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`bot_id`, `id`),
	FOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `personal_assistants` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`owner_human_id` text NOT NULL,
	`owner_generation` integer NOT NULL,
	`assignment_id` text NOT NULL,
	`epoch` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`credential_id` text,
	`is_default` integer DEFAULT 1 NOT NULL,
	`duties` text DEFAULT '' NOT NULL,
	`environment_json` text DEFAULT '{"kind":"local"}' NOT NULL,
	`config_revision` integer DEFAULT 0 NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`create_key` text,
	`create_fingerprint` text,
	`model_selection` text,
	`model_revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_human_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_assistants_default_boolean" CHECK(is_default IN (0,1)),
	CONSTRAINT "personal_assistants_paused_boolean" CHECK(paused IN (0,1)),
	CONSTRAINT "personal_assistants_state" CHECK(state IN ('claimed','revoked'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_default_owner_unique` ON `personal_assistants` (`owner_human_id`) WHERE "personal_assistants"."is_default"=1;--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_create_key` ON `personal_assistants` (`owner_human_id`,`create_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_actor_unique` ON `personal_assistants` (`actor_id`);--> statement-breakpoint
ALTER TABLE `actor_messages` ADD `author_display_name` text;