CREATE TABLE `employee_policy` (
	`singleton` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`active` text NOT NULL,
	`draft` text NOT NULL,
	CONSTRAINT "employee_policy_check_0" CHECK(singleton=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `employee_policy_audit` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `employee_policy_identities` (
	`subject` text PRIMARY KEY NOT NULL,
	`login_name` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `employee_policy_versions` (
	`revision` integer PRIMARY KEY,
	`config` text NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL
) STRICT;
