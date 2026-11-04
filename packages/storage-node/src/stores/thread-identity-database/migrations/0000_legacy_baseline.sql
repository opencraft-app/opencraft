CREATE TABLE `execution_leases` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`generation` integer NOT NULL,
	`turn_id` text,
	`engine_incarnation` text,
	`state` text NOT NULL,
	`admitted_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`boot_id` text,
	`admitted_at_boot_ms` real,
	`ended_at_boot_ms` real,
	CONSTRAINT "execution_leases_check_0" CHECK(state IN ('pending','active','ended','unknown','rejected'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `execution_leases_boot_origin` ON `execution_leases` (`thread_id`, `boot_id`, `admitted_at_boot_ms`, `ended_at_boot_ms`);--> statement-breakpoint
CREATE INDEX `execution_leases_origin` ON `execution_leases` (`thread_id`, `admitted_at_ms`, `ended_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_execution_leases_3` ON `execution_leases` (`thread_id`, `turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_execution_leases_2` ON `execution_leases` (`thread_id`, `generation`);--> statement-breakpoint
CREATE TABLE `execution_queue_inputs` (
	`thread_id` text NOT NULL,
	`queue_id` text NOT NULL,
	`input_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `queue_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `execution_submissions` (
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`principal_json` text,
	`ownership` text NOT NULL,
	`submitted_at_ms` integer NOT NULL,
	`admission` text DEFAULT 'accepted' NOT NULL,
	`input_kind` text DEFAULT 'start' NOT NULL,
	`admission_token` text,
	PRIMARY KEY(`thread_id`, `input_id`),
	CONSTRAINT "execution_submissions_check_0" CHECK(ownership IN ('human','unowned','unknown')),
	CONSTRAINT "execution_submissions_check_1" CHECK(admission IN ('pending','accepted','unknown')),
	CONSTRAINT "execution_submissions_check_2" CHECK(input_kind IN ('start','queue','steer','system'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `ioa_message_presence` (
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`login_name` text NOT NULL,
	PRIMARY KEY(`thread_id`, `client_message_id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `ioa_presence_names` ON `ioa_message_presence` (`thread_id`, `login_name`);--> statement-breakpoint
CREATE TABLE `ioa_participant_state` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `ioa_presence_sync` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`reconciled_at_ms` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `ioa_thread_creators` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`login_name` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `message_sender_origins` (
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`source_thread_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `client_message_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `message_senders` (
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`sender_json` text NOT NULL,
	`accepted_at_ms` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `client_message_id`)
) STRICT;
