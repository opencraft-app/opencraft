CREATE TABLE `resource_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `resource_legacy_heads` (
	`owner` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `resource_mutations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `resource_mutations_owner_seq` ON `resource_mutations` (`owner`, `seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_resource_mutations_1` ON `resource_mutations` (`owner`, `id`);--> statement-breakpoint
CREATE TABLE `resource_records` (
	`owner` text NOT NULL,
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`value` text,
	`page_ref` text,
	`lease_ref` text,
	`scope_ref` text,
	PRIMARY KEY(`owner`, `collection`, `id`),
	CONSTRAINT "resource_records_check_0" CHECK(revision>0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `resource_records_scope` ON `resource_records` (`owner`, `collection`, `scope_ref`);--> statement-breakpoint
CREATE INDEX `resource_records_lease` ON `resource_records` (`owner`, `collection`, `lease_ref`);--> statement-breakpoint
CREATE INDEX `resource_records_page` ON `resource_records` (`owner`, `collection`, `page_ref`);