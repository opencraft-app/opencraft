CREATE TABLE `collaboration_space_invitations` (
	`digest` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_by` text,
	FOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `collaboration_space_members` (
	`space_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `actor_id`),
	FOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collaboration_space_role" CHECK(role IN ('owner','member'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `collaboration_space_threads` (
	`engine_server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`space_id` text NOT NULL,
	PRIMARY KEY(`engine_server_id`, `thread_id`),
	FOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `collaboration_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_actor_id` text NOT NULL,
	`created_at` integer NOT NULL
) STRICT;
