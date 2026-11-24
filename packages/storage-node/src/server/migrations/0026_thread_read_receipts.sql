CREATE TABLE `thread_read_receipts` (
	`actor_id` text NOT NULL,
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`actor_id`, `host_id`, `thread_id`, `turn_id`),
	CONSTRAINT "thread_read_receipts_sequence" CHECK(sequence > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_read_receipts_actor_sequence` ON `thread_read_receipts` (`actor_id`,`sequence`);