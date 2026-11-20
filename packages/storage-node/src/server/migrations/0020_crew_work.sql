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
CREATE INDEX `crew_work_root` ON `crew_work` (`root_id`);