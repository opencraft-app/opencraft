CREATE TABLE `client_resources` (
	`identity` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`authority` text NOT NULL,
	`revision` integer NOT NULL,
	`version` integer NOT NULL,
	`saved_at` integer NOT NULL,
	`value_json` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `client_resources_remote` ON `client_resources` (`authority`, `saved_at`);--> statement-breakpoint
CREATE TABLE `connector_configuration` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "connector_configuration_check_0" CHECK(id=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `desktop_client_imports` (
	`source` text PRIMARY KEY NOT NULL,
	`row_count` integer NOT NULL,
	`digest` text NOT NULL,
	`imported_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `extension_records` (
	`scope` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`data_version` integer NOT NULL,
	`value_json` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `ui_preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
