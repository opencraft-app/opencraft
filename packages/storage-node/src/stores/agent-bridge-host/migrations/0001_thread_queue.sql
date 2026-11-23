CREATE TABLE `opencraft_host_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`client_id` text NOT NULL,
	`input_json` text NOT NULL,
	`position` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`state` text NOT NULL,
	`target_turn_id` text,
	`paused_reason` text,
	CONSTRAINT "opencraft_host_queue_check_0" CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed'))
);
--> statement-breakpoint
CREATE INDEX `opencraft_host_queue_state` ON `opencraft_host_queue` (`state`,`thread_id`);--> statement-breakpoint
CREATE INDEX `opencraft_host_queue_turn` ON `opencraft_host_queue` (`thread_id`,`target_turn_id`,`state`);--> statement-breakpoint
CREATE INDEX `opencraft_host_queue_order` ON `opencraft_host_queue` (`thread_id`,`position`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `opencraft_host_queue_client` ON `opencraft_host_queue` (`thread_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `opencraft_input_delivery` (
	`thread_id` text NOT NULL,
	`client_id` text NOT NULL,
	`native_admission` text NOT NULL,
	`context_state` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `client_id`),
	FOREIGN KEY (`thread_id`,`client_id`) REFERENCES `opencraft_host_queue`(`thread_id`,`client_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "opencraft_input_delivery_check_0" CHECK(native_admission IN ('pending','accepted','unknown','rejected')),
	CONSTRAINT "opencraft_input_delivery_check_1" CHECK(context_state IN ('unobserved','recorded'))
);
--> statement-breakpoint
CREATE TABLE `opencraft_turn_delivery` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`outcome` text NOT NULL,
	`observed_at_ms` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`),
	CONSTRAINT "opencraft_turn_delivery_check_0" CHECK(outcome IN ('completed','interrupted','failed'))
);
