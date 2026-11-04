CREATE TABLE `conversation_events` (
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer NOT NULL,
	`event_key` text NOT NULL,
	`event_type` text NOT NULL,
	`hash` text NOT NULL,
	`current` integer NOT NULL,
	`record_id` text,
	`group_id` text,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`position` real NOT NULL,
	`preview` text NOT NULL,
	`coverage` text NOT NULL,
	`source_cursor` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `thread_id`, `revision`),
	FOREIGN KEY (`scope`,`thread_id`) REFERENCES `conversation_threads`(`scope`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope`,`hash`) REFERENCES `conversation_payloads`(`scope`,`hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_events_coverage" CHECK(coverage IN ('headers','partial','complete')),
	CONSTRAINT "conversation_events_current_flag" CHECK(current IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `conversation_events_identity` ON `conversation_events` (`scope`,`thread_id`,`event_key`,`current`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_current` ON `conversation_events` (`scope`,`thread_id`,`event_key`) WHERE current=1;--> statement-breakpoint
CREATE INDEX `conversation_events_order` ON `conversation_events` (`scope`,`thread_id`,`current`,`kind`,`group_id`,`position`);--> statement-breakpoint
CREATE INDEX `conversation_events_summary` ON `conversation_events` (`scope`,`thread_id`,`current`,`group_id`,`type`,`position`);--> statement-breakpoint
CREATE TABLE `conversation_payloads` (
	`scope` text NOT NULL,
	`hash` text NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`scope`, `hash`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversation_threads` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`epoch` text NOT NULL,
	`metadata` text NOT NULL,
	`revision` integer NOT NULL,
	`history` text NOT NULL,
	`archived` integer NOT NULL,
	`deleted` integer NOT NULL,
	`recency` real NOT NULL,
	PRIMARY KEY(`scope`, `id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `conversation_directory` ON `conversation_threads` (`scope`,`archived`,`deleted`,`recency`,`id`);