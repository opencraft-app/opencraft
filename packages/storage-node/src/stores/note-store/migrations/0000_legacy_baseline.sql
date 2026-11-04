CREATE TABLE `thread_notes` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`state` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`)
) STRICT;
