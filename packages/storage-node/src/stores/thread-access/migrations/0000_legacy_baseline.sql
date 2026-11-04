CREATE TABLE `thread_access` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`creator_actor_id` text,
	`access_mode` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`),
	CONSTRAINT "thread_access_check_0" CHECK(access_mode IN ('shared','private')),
	CONSTRAINT "thread_access_check_1" CHECK(revision>=1),
	CONSTRAINT "thread_access_check_2" CHECK(access_mode!='private' OR creator_actor_id IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE `thread_access_audit` (
	`id` integer PRIMARY KEY,
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`access_mode` text NOT NULL,
	`revision` integer NOT NULL,
	`at` integer NOT NULL
) STRICT;
