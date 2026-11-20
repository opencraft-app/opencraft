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
CREATE INDEX `actor_channel_mentions_receiver` ON `actor_channel_mentions` (`actor_id`,`message_id`);