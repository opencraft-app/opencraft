CREATE TABLE `push_default_decisions` (
	`actor_id` text NOT NULL,
	`policy_id` text NOT NULL,
	PRIMARY KEY(`actor_id`, `policy_id`)
);
--> statement-breakpoint
CREATE TABLE `push_target_opt_outs` (
	`actor_id` text NOT NULL,
	`target_key` text NOT NULL,
	PRIMARY KEY(`actor_id`, `target_key`)
);
--> statement-breakpoint
ALTER TABLE `push_preferences` ADD `defaults_blocked` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE push_preferences SET defaults_blocked=1 WHERE enabled=0;
