CREATE TABLE `task_conversations` (
	`task_id` text NOT NULL,
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `server_id`, `thread_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `conversations_by_thread` ON `task_conversations` (`server_id`, `thread_id`, `task_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`task_revision` integer NOT NULL,
	`actor` text,
	`channel` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_events_check_0" CHECK(type IN ('created','updated','status_changed','linked','unlinked','deleted','restored','progress')),
	CONSTRAINT "task_events_check_1" CHECK(task_revision>0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_progress_by_task` ON `task_events` (`task_id`, seq DESC) WHERE type='progress';--> statement-breakpoint
CREATE INDEX `task_events_by_task` ON `task_events` (`task_id`, seq DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_task_events_1` ON `task_events` (`event_id`);--> statement-breakpoint
CREATE TABLE `task_members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`identity_kind` text,
	`identity_id` text,
	CONSTRAINT "task_members_check_0" CHECK(length(trim(name))>0),
	CONSTRAINT "task_members_check_1" CHECK(revision>0),
	CONSTRAINT "task_members_check_2" CHECK(
 (identity_kind IS NULL AND identity_id IS NULL) OR
 (identity_kind IS NOT NULL AND identity_id IS NOT NULL AND length(trim(identity_kind)) BETWEEN 1 AND 64 AND length(trim(identity_id)) BETWEEN 1 AND 256)
)
) STRICT;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`project_server_id` text,
	`project_id` text,
	`sort_order` integer NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`assignee_id` text,
	`priority` text DEFAULT 'none' NOT NULL,
	`due_date` text,
	`kind` text DEFAULT 'unclassified' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`assignee_id`) REFERENCES `task_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_check_0" CHECK(length(trim(title))>0),
	CONSTRAINT "tasks_check_1" CHECK(status IN ('backlog','todo','in_progress','in_review','done','canceled')),
	CONSTRAINT "tasks_check_2" CHECK(revision>0),
	CONSTRAINT "tasks_check_3" CHECK(priority IN ('none','low','normal','high','urgent')),
	CONSTRAINT "tasks_check_4" CHECK((project_server_id IS NULL AND project_id IS NULL) OR (project_server_id IS NOT NULL AND project_id IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX `tasks_active_order` ON `tasks` (`status`, `sort_order`, `id`) WHERE archived_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `tasks_archive_page` ON `tasks` (archived_at DESC, id DESC) WHERE archived_at IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `tasks_by_assignee` ON `tasks` (`assignee_id`, `status`, `sort_order`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `tasks_by_status` ON `tasks` (`status`, `sort_order`, `id`) WHERE deleted_at IS NULL;