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
CREATE UNIQUE INDEX `actor_channel_sources_channel` ON `actor_channel_sources` (`channel_id`);