CREATE TABLE `personal_assistants` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`owner_human_id` text NOT NULL,
	`owner_generation` integer NOT NULL,
	`assignment_id` text NOT NULL,
	`epoch` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_human_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_assistants_state" CHECK(state IN ('claimed','revoked'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_owner_unique` ON `personal_assistants` (`owner_human_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_actor_unique` ON `personal_assistants` (`actor_id`);