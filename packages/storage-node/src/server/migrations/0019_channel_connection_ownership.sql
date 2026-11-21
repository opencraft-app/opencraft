CREATE TABLE `actor_channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`incarnation` text NOT NULL,
	`active` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_source_owners` (
	`source` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	FOREIGN KEY (`source`) REFERENCES `actor_channel_sources`(`source`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `actor_channel_connections`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
