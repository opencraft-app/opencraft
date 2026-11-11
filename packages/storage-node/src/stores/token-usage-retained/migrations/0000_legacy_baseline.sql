CREATE TABLE `usage_events` (
	`seq` integer PRIMARY KEY,
	`thread_id` text NOT NULL,
	`event_key` text NOT NULL,
	`at_ms` integer NOT NULL,
	`kind` text NOT NULL,
	`data_json` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_usage_events_1` ON `usage_events` (`event_key`);--> statement-breakpoint
CREATE TABLE `usage_files` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`cursor` integer NOT NULL,
	`identity` text,
	`error` text,
	`complete` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `usage_legacy` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`value_json` text NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`)
) STRICT;
