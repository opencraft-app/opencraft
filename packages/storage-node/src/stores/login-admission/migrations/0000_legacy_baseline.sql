CREATE TABLE `login_admission_audit` (
	`id` integer PRIMARY KEY,
	`policy` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL,
	`detail` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `login_admission_audit_policy` ON `login_admission_audit` (`policy`,`id`);--> statement-breakpoint
CREATE TABLE `login_admission_identities` (
	`policy` text NOT NULL,
	`subject` text NOT NULL,
	`attributes` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`policy`, `subject`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `login_admission_imports` (
	`policy` text NOT NULL,
	`source` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`policy`, `source`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `login_admission_policies` (
	`policy` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`rules` text NOT NULL,
	`updated_at` integer NOT NULL,
	`operator` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `login_admission_versions` (
	`policy` text NOT NULL,
	`revision` integer NOT NULL,
	`rules` text NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL,
	PRIMARY KEY(`policy`, `revision`)
) STRICT;
