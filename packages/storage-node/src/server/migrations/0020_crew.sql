CREATE TABLE `crew_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`work_id` text NOT NULL,
	`from_work_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`asks` integer DEFAULT 0 NOT NULL,
	`answers` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `crew_messages_message_id_unique` ON `crew_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `crew_messages_recipient` ON `crew_messages` (`recipient_id`,`seq`);--> statement-breakpoint
CREATE TABLE `crew_work` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`assignee_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`parent_id` text,
	`root_id` text NOT NULL,
	`origin` text NOT NULL,
	`message_id` text,
	`state` text NOT NULL,
	`dispatches` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "crew_work_origin" CHECK(origin IN ('member','bot','routine')),
	CONSTRAINT "crew_work_state" CHECK(state IN ('open','closed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `crew_work_assignee` ON `crew_work` (`assignee_id`,`state`);--> statement-breakpoint
CREATE INDEX `crew_work_root` ON `crew_work` (`root_id`);--> statement-breakpoint
ALTER TABLE `collaboration_spaces` ADD `open_contact` integer DEFAULT 0 NOT NULL;