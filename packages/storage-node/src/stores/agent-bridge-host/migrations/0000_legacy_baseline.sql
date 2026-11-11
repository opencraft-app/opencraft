CREATE TABLE `automation_scripts` (
	`key` text PRIMARY KEY,
	`digest` text NOT NULL,
	`state` text NOT NULL,
	`result` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `callbacks` (
	`generation` text NOT NULL,
	`id` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`generation`, `id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`route` text PRIMARY KEY,
	`state` text NOT NULL,
	`at_ms` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY,
	`digest` text NOT NULL,
	`epoch` integer NOT NULL,
	`route` text NOT NULL,
	`generation` text NOT NULL,
	`method` text NOT NULL,
	`state` text NOT NULL,
	`response` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY,
	`config` text NOT NULL,
	`retired` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `inbox` (
	`seq` integer PRIMARY KEY,
	`route` text NOT NULL,
	`generation` text NOT NULL,
	`payload` text NOT NULL,
	`projection` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `interactions` (
	`route` text NOT NULL,
	`id` text NOT NULL,
	`generation` text NOT NULL,
	PRIMARY KEY(`route`, `id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `native_sessions` (
	`route` text PRIMARY KEY,
	`generation` text NOT NULL,
	`native_id` text NOT NULL,
	`restorable` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route` text NOT NULL,
	`generation` text NOT NULL,
	`payload` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `released_routes` (
	`route` text PRIMARY KEY,
	`generation` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `routes` (
	`route` text PRIMARY KEY,
	`generation` text NOT NULL,
	FOREIGN KEY (`generation`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
