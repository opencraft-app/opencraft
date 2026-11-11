CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `schedule_runs_thread` ON `schedule_runs` (`thread_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) STRICT;
