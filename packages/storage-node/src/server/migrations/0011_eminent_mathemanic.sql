CREATE TABLE `assistant_thread_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`epoch` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`work_id` text,
	`profile_id` text NOT NULL,
	`profile_revision` integer NOT NULL,
	`state` text NOT NULL,
	`reference` text,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_thread_operation_key` ON `assistant_thread_operations` (`bot_id`,`epoch`,`request_key`);--> statement-breakpoint
CREATE TABLE `assistant_thread_profiles` (
	`bot_id` text NOT NULL,
	`id` text NOT NULL,
	`epoch` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`settings` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`bot_id`, `id`),
	FOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action
) STRICT;
