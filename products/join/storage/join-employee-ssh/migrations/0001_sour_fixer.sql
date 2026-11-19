CREATE TABLE `employee_cli_key_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operator` text NOT NULL,
	`employee` text NOT NULL,
	`actor_id` text,
	`fingerprint` text,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employee_cli_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`subject` text NOT NULL,
	`username` text NOT NULL,
	`generation` integer NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text
);
--> statement-breakpoint
CREATE INDEX `employee_cli_keys_actor` ON `employee_cli_keys` (`actor_id`);--> statement-breakpoint
CREATE INDEX `employee_cli_keys_fingerprint` ON `employee_cli_keys` (`fingerprint`);