CREATE TABLE `admission` (
	`singleton` integer PRIMARY KEY,
	`generation_id` text,
	`epoch` integer NOT NULL,
	CONSTRAINT "admission_check_0" CHECK(singleton=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `creation_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`state` text NOT NULL,
	`thread_id` text,
	`incarnation` integer,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`runtime_root` text NOT NULL,
	`endpoint` text NOT NULL,
	`state` text NOT NULL,
	`incarnation` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_generations_3` ON `generations` (`endpoint`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_generations_2` ON `generations` (`runtime_root`);--> statement-breakpoint
CREATE TABLE `routing_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `thread_routes` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`epoch` integer NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
