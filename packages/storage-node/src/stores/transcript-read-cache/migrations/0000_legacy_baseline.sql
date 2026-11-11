CREATE TABLE `opencraft_cache_blobs` (
	`thread_id` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`blob_sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_seq`, `blob_sha256`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_cache_meta` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`projection_schema_version` integer NOT NULL,
	`native_watermark` text NOT NULL,
	`source_cursor` integer NOT NULL,
	`source_identity` text NOT NULL,
	`source_path` text NOT NULL,
	`epoch` text NOT NULL,
	`total_turns` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_turn_offset_index` (
	`thread_id` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`turn_id` text NOT NULL,
	`byte_offset` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`status` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_seq`)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_unique_opencraft_turn_offset_index_2` ON `opencraft_turn_offset_index` (`thread_id`, `turn_id`);