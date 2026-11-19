CREATE TABLE `connector_credentials` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`secrets` text NOT NULL,
	`oauth` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `connector_instances`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `connector_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`title` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `connector_oauth_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_connector_oauth_transactions_2` ON `connector_oauth_transactions` (`state`);