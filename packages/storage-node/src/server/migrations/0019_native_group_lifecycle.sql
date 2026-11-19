CREATE TABLE `actor_channel_departures` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`member_epoch` text NOT NULL,
	`left_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
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
