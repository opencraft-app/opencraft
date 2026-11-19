CREATE TABLE `opencraft_catalog_sync` (
	`archived` integer PRIMARY KEY,
	`last_success_ms` integer,
	`watermark` real,
	`last_full_ms` integer,
	`state` text NOT NULL,
	CONSTRAINT "opencraft_catalog_sync_check_0" CHECK(archived IN (0,1)),
	CONSTRAINT "opencraft_catalog_sync_check_1" CHECK(state IN ('syncing','ready','error'))
);
--> statement-breakpoint
CREATE TABLE `opencraft_thread_catalog` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`metadata_json` text NOT NULL,
	`updated_at` real NOT NULL,
	`archived` integer NOT NULL,
	`observed_at_ms` integer NOT NULL,
	`revision` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "opencraft_thread_catalog_check_0" CHECK(archived IN (0,1)),
	CONSTRAINT "opencraft_thread_catalog_check_1" CHECK(deleted IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `opencraft_thread_catalog_recency` ON `opencraft_thread_catalog` (`archived`,`deleted`,updated_at DESC,`thread_id`);