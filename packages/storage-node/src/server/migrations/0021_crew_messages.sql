CREATE TABLE `crew_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`work_id` text NOT NULL,
	`from_work_id` text NOT NULL,
	`created_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `crew_messages_message_id_unique` ON `crew_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `crew_messages_recipient` ON `crew_messages` (`recipient_id`,`seq`);