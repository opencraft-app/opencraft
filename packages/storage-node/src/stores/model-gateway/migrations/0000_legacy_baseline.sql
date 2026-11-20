CREATE TABLE `gateway_audit` (
	`id` integer PRIMARY KEY,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_contributions` (
	`provider` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`template_provider` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`scope` text DEFAULT 'team' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gateway_contributions_check_0" CHECK(state IN ('preparing','shared','withdrawn')),
	CONSTRAINT "gateway_contributions_check_1" CHECK(scope IN ('personal','team'))
);
--> statement-breakpoint
CREATE TABLE `gateway_execution_heads` (
	`thread` text PRIMARY KEY NOT NULL,
	`execution` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_execution_turns` (
	`thread` text NOT NULL,
	`turn` text NOT NULL,
	`execution` text NOT NULL,
	PRIMARY KEY(`thread`, `turn`)
);
--> statement-breakpoint
CREATE TABLE `gateway_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread` text NOT NULL,
	`authorizer` text NOT NULL,
	`executor` text,
	`model` text NOT NULL,
	`parent` text,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`authority` text,
	CONSTRAINT "gateway_executions_check_0" CHECK(state IN ('active','closed','revoked'))
);
--> statement-breakpoint
CREATE TABLE `gateway_limits` (
	`actor` text PRIMARY KEY NOT NULL,
	`monthly_tokens` integer NOT NULL,
	`request_tokens` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "gateway_limits_check_0" CHECK(monthly_tokens>=0),
	CONSTRAINT "gateway_limits_check_1" CHECK(request_tokens>0),
	CONSTRAINT "gateway_limits_check_2" CHECK(concurrency>0)
);
--> statement-breakpoint
CREATE TABLE `gateway_personal_limits` (
	`actor` text PRIMARY KEY NOT NULL,
	`monthly_tokens` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "gateway_personal_limits_check_0" CHECK(monthly_tokens>=0)
);
--> statement-breakpoint
CREATE TABLE `gateway_private_threads` (
	`thread` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`thread` text NOT NULL,
	`model` text NOT NULL,
	`credential` text,
	`period` text NOT NULL,
	`reserved` integer NOT NULL,
	`actual` integer,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`execution` text,
	`key_owner` text,
	`turn` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	CONSTRAINT "gateway_requests_check_0" CHECK(reserved>0),
	CONSTRAINT "gateway_requests_check_1" CHECK(actual>=0),
	CONSTRAINT "gateway_requests_check_2" CHECK(state IN ('reserved','dispatched','settled','released','unknown'))
);
--> statement-breakpoint
CREATE INDEX `gateway_requests_turn` ON `gateway_requests` (`thread`,`turn`);--> statement-breakpoint
CREATE INDEX `gateway_requests_actor` ON `gateway_requests` (`actor`,`period`,`state`);--> statement-breakpoint
CREATE TABLE `gateway_sponsors` (
	`thread` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`parent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_thread_humans` (
	`thread` text NOT NULL,
	`actor` text NOT NULL,
	PRIMARY KEY(`thread`, `actor`)
);
--> statement-breakpoint
CREATE TABLE `gateway_thread_models` (
	`thread` text PRIMARY KEY NOT NULL,
	`creator` text NOT NULL,
	`provider` text NOT NULL,
	`contribution_revision` integer NOT NULL,
	`created_at` integer NOT NULL
);
