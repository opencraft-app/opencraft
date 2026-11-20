CREATE TABLE `actor_channel_reads` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`epoch` text NOT NULL,
	`joined_seq` integer NOT NULL,
	`read_seq` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`)
) STRICT;
--> statement-breakpoint
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
CREATE INDEX `actor_inbox_changes` ON `actor_inbox_rows` (`actor_id`,`revision`);