CREATE TABLE `employee_ssh_credentials` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`username` text NOT NULL,
	`generation` integer NOT NULL,
	`private_key` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_employee_ssh_credentials_3` ON `employee_ssh_credentials` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_employee_ssh_credentials_2` ON `employee_ssh_credentials` (`subject`);