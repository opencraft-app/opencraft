CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `push_deliveries_due` ON `push_deliveries` (`state`, `next_at`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`authorization` text NOT NULL,
	`subscription` text NOT NULL,
	`origin` text NOT NULL,
	`base_path` text NOT NULL,
	`locale` text NOT NULL,
	`messages` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `push_devices_actor` ON `push_devices` (`actor_id`);--> statement-breakpoint
CREATE TABLE `push_keys` (
	`id` integer PRIMARY KEY,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	CONSTRAINT "push_keys_check_0" CHECK(id=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `push_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`server_id` text NOT NULL,
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`turn_id` text,
	`created_at` integer NOT NULL,
	`done` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `push_watches_pending` ON `push_watches` (`done`, `created_at`);