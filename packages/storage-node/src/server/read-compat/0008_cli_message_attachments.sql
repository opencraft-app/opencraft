CREATE TABLE `conversation_attachment_bindings` (
	`request_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`attachment_id` text NOT NULL,
	`descriptor_json` text NOT NULL,
	PRIMARY KEY(`request_id`, `ordinal`),
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `conversation_attachment_uploads`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversation_attachment_chunks` (
	`attachment_id` text NOT NULL,
	`offset` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`attachment_id`, `offset`),
	FOREIGN KEY (`attachment_id`) REFERENCES `conversation_attachment_uploads`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversation_attachment_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`generation` integer NOT NULL,
	`server_id` text NOT NULL,
	`target_json` text NOT NULL,
	`operation_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`descriptor_json` text NOT NULL,
	`received` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`request_id` text,
	`creation_id` text,
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_attachment_state" CHECK(state IN ('uploading','ready','bound','delivered'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_attachment_identity` ON `conversation_attachment_uploads` (`actor_id`,`generation`,`operation_key`,`ordinal`);--> statement-breakpoint
CREATE INDEX `conversation_attachment_expiry` ON `conversation_attachment_uploads` (`state`,`expires_at`);