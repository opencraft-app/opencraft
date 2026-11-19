CREATE TABLE `automation_delegations` (
	`authority_id` text PRIMARY KEY NOT NULL,
	`run_key` text NOT NULL,
	`grant_id` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `automation_delegations_run` ON `automation_delegations` (`run_key`);--> statement-breakpoint
CREATE TABLE `automation_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`generation` integer NOT NULL,
	`scope_json` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_mutations` (
	`actor_id` text NOT NULL,
	`key` text NOT NULL,
	`digest` text NOT NULL,
	`result` text NOT NULL,
	PRIMARY KEY(`actor_id`, `key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`occurrence_id` text NOT NULL,
	`state` text NOT NULL,
	`at` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "automation_run_state" CHECK(state IN ('planned','admitted','running','completed','failed','unknown','skipped'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `automation_runs_owner` ON `automation_runs` (`automation_id`,`at`);--> statement-breakpoint
CREATE INDEX `automation_runs_state` ON `automation_runs` (`state`);--> statement-breakpoint
CREATE TABLE `project_automations` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `project_automations_project` ON `project_automations` (`project_id`,`id`);