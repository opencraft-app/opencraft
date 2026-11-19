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
CREATE INDEX `client_resources_remote` ON `client_resources` (`authority`, `saved_at`);