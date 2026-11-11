CREATE TABLE `dsh_pending_generations` (
	`native_id` text PRIMARY KEY,
	`logical_id` text NOT NULL,
	`intent` text
);
--> statement-breakpoint
CREATE TABLE `dsh_session_generations` (
	`logical_id` text NOT NULL,
	`native_id` text NOT NULL,
	`generation` integer NOT NULL,
	`seed_seq` integer NOT NULL,
	`seed_turn` integer NOT NULL,
	`prior_seq` integer NOT NULL,
	`prior_turn` integer NOT NULL,
	PRIMARY KEY(`logical_id`, `generation`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_dsh_session_generations_1` ON `dsh_session_generations` (`native_id`);