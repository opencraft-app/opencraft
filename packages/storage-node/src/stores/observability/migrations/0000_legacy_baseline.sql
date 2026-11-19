CREATE TABLE `activity_hours` (
	`hour` integer NOT NULL,
	`actor` text NOT NULL,
	PRIMARY KEY(`hour`, `actor`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `connection_outages` (
	`recovery_id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`started` integer NOT NULL,
	`observed` integer NOT NULL,
	`completed` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `connection_outage_window` ON `connection_outages` (`observed`, `started`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY,
	`event_id` text NOT NULL,
	`at` integer NOT NULL,
	`received` integer NOT NULL,
	`kind` text NOT NULL,
	`component` text NOT NULL,
	`actor` text,
	`body` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `gateway_lifecycle_window` ON `events` (`at`, `seq`) WHERE kind='lifecycle' AND component='gateway';--> statement-breakpoint
CREATE INDEX `events_availability` ON `events` (`at`, `seq`) WHERE kind='availability';--> statement-breakpoint
CREATE INDEX `events_incident` ON `events` (json_extract(body,'$.incidentRef'), `at`) WHERE json_extract(body,'$.incidentRef') IS NOT NULL;--> statement-breakpoint
CREATE INDEX `events_received` ON `events` (`received`);--> statement-breakpoint
CREATE INDEX `events_window` ON `events` (`at`, `received`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_events_1` ON `events` (`event_id`);--> statement-breakpoint
CREATE TABLE `execution_progress` (
	`domain_key` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`stage` text NOT NULL,
	`progress_at` integer NOT NULL,
	`received` integer NOT NULL,
	`terminal` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `execution_progress_active` ON `execution_progress` (`terminal`, `received`);--> statement-breakpoint
CREATE TABLE `executions` (
	`domain_key` text PRIMARY KEY NOT NULL,
	`started` integer,
	`ended` integer,
	`outcome` text NOT NULL,
	`updated` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `executions_window` ON `executions` (`started`, `ended`);--> statement-breakpoint
CREATE TABLE `metrics` (
	`name` text NOT NULL,
	`dimension` text NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`name`, `dimension`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `producers` (
	`component` text NOT NULL,
	`producer` text NOT NULL,
	`received` integer NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`component`, `producer`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `producers_freshness` ON `producers` (`component`, received DESC, producer DESC);--> statement-breakpoint
CREATE TABLE `queue_samples` (
	`domain_key` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`count` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`received` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `recovery_episodes` (
	`recovery_id` text PRIMARY KEY NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`outcome` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `recovery_window` ON `recovery_episodes` (`first_at`, `last_at`);