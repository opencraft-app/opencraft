CREATE TABLE `im_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`config` text NOT NULL,
	`revision` integer NOT NULL,
	`route` text,
	`draft` text,
	`enabled` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `im_identity_challenges` (
	`hash` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`expires_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `im_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`actor_id` text NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL,
	`route_revision` integer NOT NULL,
	`decision` text,
	`conversation_ref` text,
	`request_id` text,
	`reply_address` text,
	`reply_text` text,
	`state` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`reply_mode` text DEFAULT 'final' NOT NULL,
	`reply_ref` text,
	`reply_expires_at` integer
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `im_messages_reply_ref` ON `im_messages` (`reply_ref`) WHERE reply_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX `im_messages_channel` ON `im_messages` (`channel_id`, `created_at`);--> statement-breakpoint
CREATE TABLE `im_route_versions` (
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `revision`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `im_sender_links` (
	`channel_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`channel_id`, `sender_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `switchboard` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_endpoint_id` text NOT NULL,
	`source_key` text NOT NULL,
	`conversation_ref` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_switchboard_2` ON `switchboard` (`bot_endpoint_id`, `source_key`);