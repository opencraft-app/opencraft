CREATE TABLE `execution_capability_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`session_json` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_capability_bindings_server_id_thread_id_unique` ON `execution_capability_bindings` (`server_id`,`thread_id`);