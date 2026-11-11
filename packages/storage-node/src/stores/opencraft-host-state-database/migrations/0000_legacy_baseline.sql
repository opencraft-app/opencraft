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
--> statement-breakpoint
CREATE TABLE `opencraft_bot_commands` (
	`command_key` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`result_json` text
);
--> statement-breakpoint
CREATE TABLE `opencraft_bot_message_slots` (
	`room_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`native_id` text,
	PRIMARY KEY(`room_id`, `turn_id`, `kind`, `ordinal`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_opencraft_bot_message_slots_2` ON `opencraft_bot_message_slots` (`room_id`, `turn_id`, `kind`, `native_id`);--> statement-breakpoint
CREATE TABLE `opencraft_bot_rooms` (
	`thread_id` text PRIMARY KEY,
	`created_ms` integer NOT NULL,
	`cwd` text,
	`draft` integer DEFAULT 0 NOT NULL,
	`native_thread_id` text
);
--> statement-breakpoint
CREATE TABLE `opencraft_catalog_sync` (
	`archived` integer PRIMARY KEY,
	`last_success_ms` integer,
	`watermark` real,
	`last_full_ms` integer,
	`state` text NOT NULL,
	CONSTRAINT "opencraft_catalog_sync_check_0" CHECK(archived IN (0,1)),
	CONSTRAINT "opencraft_catalog_sync_check_1" CHECK(state IN ('syncing','ready','error'))
) STRICT;
--> statement-breakpoint
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
	CONSTRAINT "opencraft_host_queue_check_0" CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_host_queue_state` ON `opencraft_host_queue` (`state`, `thread_id`);--> statement-breakpoint
CREATE INDEX `opencraft_host_queue_order` ON `opencraft_host_queue` (`thread_id`, `position`, `created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_opencraft_host_queue_2` ON `opencraft_host_queue` (`thread_id`, `client_id`);--> statement-breakpoint
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
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_thread_catalog_recency` ON `opencraft_thread_catalog` (`archived`, `deleted`, updated_at DESC, `thread_id`);--> statement-breakpoint
CREATE TABLE `token_usage_actor_daily` (
	`server_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`day` text NOT NULL,
	`model_filter` integer NOT NULL,
	`model_key` text NOT NULL,
	`tokens` text NOT NULL,
	`turns` integer NOT NULL,
	PRIMARY KEY(`server_id`, `actor_id`, `day`, `model_filter`, `model_key`),
	CONSTRAINT "token_usage_actor_daily_check_0" CHECK(model_filter IN (0,1)),
	CONSTRAINT "token_usage_actor_daily_check_1" CHECK(turns>=0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_admissions` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`observed_ms` integer NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `input_id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_admissions_turn` ON `token_usage_admissions` (`server_id`, `thread_id`, `turn_id`);--> statement-breakpoint
CREATE TABLE `token_usage_allocations` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`model_key` text NOT NULL,
	`provider` text,
	`model` text,
	`actor_id` text NOT NULL,
	`tokens` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`, `model_key`, `actor_id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_allocations_actor` ON `token_usage_allocations` (`server_id`, `actor_id`, `thread_id`, `turn_id`);--> statement-breakpoint
CREATE TABLE `token_usage_attempts` (
	`server_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`mode` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`source_kind` text NOT NULL,
	`submitted_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`turn_id` text,
	PRIMARY KEY(`server_id`, `attempt_id`),
	CONSTRAINT "token_usage_attempts_check_0" CHECK(mode IN ('start','steer')),
	CONSTRAINT "token_usage_attempts_check_1" CHECK(actor_kind IN ('human','session','unknown')),
	CONSTRAINT "token_usage_attempts_check_2" CHECK(source_kind IN ('human','system','unknown')),
	CONSTRAINT "token_usage_attempts_check_3" CHECK(outcome IN ('pending','accepted','rejected','unknown'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_attempts_input` ON `token_usage_attempts` (`server_id`, `thread_id`, `input_id`, `outcome`);--> statement-breakpoint
CREATE TABLE `token_usage_buckets` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`model_key` text NOT NULL,
	`provider` text,
	`model` text,
	`tokens` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`, `model_key`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_buckets_query` ON `token_usage_buckets` (`server_id`, `thread_id`, `turn_id`, `model_key`, `tokens`, `provider`, `model`);--> statement-breakpoint
CREATE INDEX `token_usage_buckets_model` ON `token_usage_buckets` (`server_id`, `model_key`, `thread_id`, `turn_id`);--> statement-breakpoint
CREATE TABLE `token_usage_checkpoints` (
	`server_id` text NOT NULL,
	`lineage` text NOT NULL,
	`cursor` text NOT NULL,
	PRIMARY KEY(`server_id`, `lineage`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_coverage` (
	`id` integer PRIMARY KEY,
	`server_id` text NOT NULL,
	`starts_ms` integer NOT NULL,
	`ends_ms` integer
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_coverage_scope` ON `token_usage_coverage` (`server_id`, `starts_ms`, `ends_ms`);--> statement-breakpoint
CREATE TABLE `token_usage_daily` (
	`server_id` text NOT NULL,
	`day` text NOT NULL,
	`model_filter` integer NOT NULL,
	`model_key` text NOT NULL,
	`allocation_state` text NOT NULL,
	`tokens` text NOT NULL,
	`turns` integer NOT NULL,
	`missing_usage` integer NOT NULL,
	`unknown_models` integer NOT NULL,
	PRIMARY KEY(`server_id`, `day`, `model_filter`, `model_key`, `allocation_state`),
	CONSTRAINT "token_usage_daily_check_0" CHECK(model_filter IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_gaps` (
	`server_id` text NOT NULL,
	`gap_key` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`reason` text NOT NULL,
	`starts_ms` integer NOT NULL,
	`ends_ms` integer,
	PRIMARY KEY(`server_id`, `gap_key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_input_conflicts` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `input_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_inputs` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`mode` text NOT NULL,
	`admission` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `input_id`),
	CONSTRAINT "token_usage_inputs_check_0" CHECK(actor_kind IN ('human','session','unknown')),
	CONSTRAINT "token_usage_inputs_check_1" CHECK(mode IN ('start','steer')),
	CONSTRAINT "token_usage_inputs_check_2" CHECK(admission IN ('confirmed','pending','rejected'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_inputs_actor_query` ON `token_usage_inputs` (`server_id`, `actor_id`, `actor_kind`, `admission`, `thread_id`, `turn_id`);--> statement-breakpoint
CREATE INDEX `token_usage_inputs_participants_query` ON `token_usage_inputs` (`server_id`, `thread_id`, `turn_id`, `admission`, `actor_kind`, `actor_id`);--> statement-breakpoint
CREATE INDEX `token_usage_inputs_turn` ON `token_usage_inputs` (`server_id`, `thread_id`, `turn_id`, `admission`);--> statement-breakpoint
CREATE TABLE `token_usage_metadata_scans` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`cursor` text,
	PRIMARY KEY(`server_id`, `thread_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_native_counters` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`epoch` text NOT NULL,
	`turn_id` text,
	`baseline_json` text NOT NULL,
	`cumulative_json` text NOT NULL,
	`source_version` integer NOT NULL,
	`broken` integer NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`),
	CONSTRAINT "token_usage_native_counters_check_0" CHECK(broken IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_native_terminals` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_projection_state` (
	`server_id` text PRIMARY KEY NOT NULL,
	`ready` integer NOT NULL,
	`cursor_thread` text NOT NULL,
	`cursor_turn` text NOT NULL,
	CONSTRAINT "token_usage_projection_state_check_0" CHECK(ready IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_rollouts` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`path` text NOT NULL,
	`cursor` text NOT NULL,
	`last_success_ms` integer,
	`error_kind` text,
	PRIMARY KEY(`server_id`, `thread_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_scopes` (
	`server_id` text PRIMARY KEY NOT NULL,
	`enabled_at_ms` integer NOT NULL,
	`enabled` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "token_usage_scopes_check_0" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_sources` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`lineage` text NOT NULL,
	`source_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_version` integer NOT NULL,
	`provider` text,
	`model` text,
	`counts_json` text NOT NULL,
	`observed_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`, `lineage`, `source_kind`, `source_id`),
	CONSTRAINT "token_usage_sources_check_0" CHECK(source_kind IN ('response','turn-snapshot'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_submissions` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`mode` text NOT NULL,
	`source_kind` text NOT NULL,
	`submitted_ms` integer NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `input_id`),
	CONSTRAINT "token_usage_submissions_check_0" CHECK(actor_kind IN ('human','session','unknown')),
	CONSTRAINT "token_usage_submissions_check_1" CHECK(mode IN ('start','steer')),
	CONSTRAINT "token_usage_submissions_check_2" CHECK(source_kind IN ('human','system','unknown'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_turn_actor_projections` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`value_json` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_turn_projections` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`value_json` text NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_usage_turns` (
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`started_ms` integer NOT NULL,
	`execution_state` text NOT NULL,
	`source_kind` text NOT NULL,
	`participants_complete` integer NOT NULL,
	`usage_complete` integer NOT NULL,
	`responses_complete` integer NOT NULL,
	`frozen` integer DEFAULT 0 NOT NULL,
	`observed_tokens` text,
	`allocation_state` text NOT NULL,
	`revision` integer NOT NULL,
	`unknown_model` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`server_id`, `thread_id`, `turn_id`),
	CONSTRAINT "token_usage_turns_check_0" CHECK(execution_state IN ('running','completed','failed','interrupted')),
	CONSTRAINT "token_usage_turns_check_1" CHECK(source_kind IN ('human','system','unknown')),
	CONSTRAINT "token_usage_turns_check_2" CHECK(participants_complete IN (0,1)),
	CONSTRAINT "token_usage_turns_check_3" CHECK(usage_complete IN (0,1)),
	CONSTRAINT "token_usage_turns_check_4" CHECK(responses_complete IN (0,1)),
	CONSTRAINT "token_usage_turns_check_5" CHECK(frozen IN (0,1)),
	CONSTRAINT "token_usage_turns_check_6" CHECK(allocation_state IN ('settled','provisional','pending','system','unknown')),
	CONSTRAINT "token_usage_turns_check_7" CHECK(unknown_model IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `token_usage_turns_query` ON `token_usage_turns` (`server_id`, `started_ms`, `thread_id`, `turn_id`, `frozen`, `allocation_state`, `observed_tokens`, `unknown_model`);--> statement-breakpoint
CREATE INDEX `token_usage_turns_date` ON `token_usage_turns` (`server_id`, `started_ms`, `thread_id`, `turn_id`);