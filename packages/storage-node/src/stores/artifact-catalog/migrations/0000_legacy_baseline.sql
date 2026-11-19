CREATE TABLE `artifact_ingestions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`path` text NOT NULL,
	`phase` text NOT NULL,
	`created_ms` integer NOT NULL
) STRICT;

--> statement-breakpoint
CREATE TABLE `artifact_leases` (
	`owner` text NOT NULL,
	`artifact_id` text NOT NULL,
	PRIMARY KEY(`owner`, `artifact_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;

--> statement-breakpoint
CREATE TABLE `artifact_references` (
	`owner` text NOT NULL,
	`slot` text NOT NULL,
	`artifact_id` text NOT NULL,
	PRIMARY KEY(`owner`, `slot`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;

--> statement-breakpoint
CREATE INDEX `artifact_reference_target` ON `artifact_references` (`artifact_id`);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`source_key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`path` text NOT NULL,
	`origin` text NOT NULL,
	`created_ms` integer NOT NULL,
	`deleting` integer DEFAULT 0 NOT NULL
) STRICT;

--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_artifacts_scope_source_key` ON `artifacts` (`scope`,`source_key`);
