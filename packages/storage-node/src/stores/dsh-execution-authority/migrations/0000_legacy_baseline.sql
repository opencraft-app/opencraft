CREATE TABLE `hypernode_thread_execution_epochs` (
	`thread_id` text PRIMARY KEY,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hypernode_thread_queue_state` (
	`thread_id` text PRIMARY KEY,
	`paused_reason` text,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hypernode_thread_queue_submissions` (
	`thread_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`client_user_message_id` text NOT NULL,
	`actor_user_id` text,
	`input_json` text NOT NULL,
	`state` text NOT NULL,
	`position` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `submission_id`)
);
--> statement-breakpoint
CREATE INDEX `hypernode_thread_queue_actor` ON `hypernode_thread_queue_submissions` (`actor_user_id`, `state`);--> statement-breakpoint
CREATE INDEX `hypernode_thread_queue_pending` ON `hypernode_thread_queue_submissions` (`thread_id`, `state`, `position`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_hypernode_thread_queue_submissions_2` ON `hypernode_thread_queue_submissions` (`thread_id`, `client_user_message_id`);--> statement-breakpoint
CREATE TABLE `hypernode_turn_execution_attempts` (
	`execution_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`request_id` text,
	`turn_id` text,
	`actor_user_id` text,
	`actor_username` text,
	`account_identity` text,
	`execution_profile_json` text,
	`runtime_id` text,
	`native_turn_id` text,
	`state` text NOT NULL,
	`owner_boot_id` text NOT NULL,
	`started_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`terminal_at_ms` integer,
	`terminal_reason` text
);
--> statement-breakpoint
CREATE INDEX `hypernode_turn_execution_thread_epoch` ON `hypernode_turn_execution_attempts` (`thread_id`, `epoch`);--> statement-breakpoint
CREATE TABLE `opencraft_execution_inputs` (
	`execution_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`native_rpc_id` text NOT NULL,
	`client_message_id` text,
	`actor_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_opencraft_execution_inputs_2` ON `opencraft_execution_inputs` (`native_rpc_id`);--> statement-breakpoint
CREATE TABLE `opencraft_queue_inputs` (
	`native_rpc_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`request_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_username` text NOT NULL,
	`connection_id` text NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL
);
