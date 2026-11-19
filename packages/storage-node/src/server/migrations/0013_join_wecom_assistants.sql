CREATE TABLE `join_wecom_assistant_replies` (
	`message_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `join_wecom_assistant_requests` (
	`message_id` text PRIMARY KEY NOT NULL,
	`scope` text,
	`source` text NOT NULL,
	`source_epoch` text NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`owner_id` text,
	`owner_generation` integer,
	`assistant_id` text,
	`assistant_epoch` text,
	`member_epoch` text,
	`reason` text
) STRICT;
--> statement-breakpoint
CREATE INDEX `join_wecom_assistant_scope` ON `join_wecom_assistant_requests` (`assistant_id`,`scope`);