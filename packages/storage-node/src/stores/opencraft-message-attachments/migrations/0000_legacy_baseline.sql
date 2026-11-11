CREATE TABLE `opencraft_message_attachments` (
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`ref_json` text NOT NULL,
	PRIMARY KEY(`thread_id`, `client_message_id`, `attachment_id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_message_attachments_message` ON `opencraft_message_attachments` (`thread_id`, `client_message_id`, `ordinal`);