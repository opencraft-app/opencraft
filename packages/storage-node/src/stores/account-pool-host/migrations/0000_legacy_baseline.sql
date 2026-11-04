CREATE TABLE `pool_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`upstream_account_id` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`email` text,
	`subscription_type` text,
	`rate_limit_tier` text,
	`last_used_at` integer,
	`last_used_host_id` text,
	`reset_credit_count` integer,
	`reset_credits_observed_at` integer,
	`allow_credits` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pool_accounts_check_0" CHECK(reset_credit_count >= 0),
	CONSTRAINT "pool_accounts_check_1" CHECK(allow_credits IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `pool_active_account` (
	`provider` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `pool_accounts`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `pool_affinity` (
	`affinity_key` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `pool_accounts`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `pool_quota` (
	`account_id` text PRIMARY KEY NOT NULL,
	`utilization` real,
	`reset_at` integer,
	`held_until` integer,
	`error` text,
	`observed_at` integer NOT NULL,
	`limit_windows_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `pool_accounts`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
