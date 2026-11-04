CREATE TABLE `actor_conversation_creations` (
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`server_id` text NOT NULL,
	`project_id` text NOT NULL,
	`cwd` text NOT NULL,
	`settings_json` text NOT NULL,
	`creation_state` text NOT NULL,
	`thread_id` text,
	`first_message_state` text NOT NULL,
	`request_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`actor_id`, `idempotency_key`)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_conversation_creation_operation` ON `actor_conversation_creations` (`operation_id`);