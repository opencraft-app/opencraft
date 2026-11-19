CREATE TABLE `model_usage_audit` (
	`revision` integer PRIMARY KEY,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	`before_rules` text NOT NULL,
	`after_rules` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `model_usage_policy` (
	`singleton` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`rules` text NOT NULL,
	CONSTRAINT "model_usage_policy_check_0" CHECK(singleton=1)
) STRICT;
