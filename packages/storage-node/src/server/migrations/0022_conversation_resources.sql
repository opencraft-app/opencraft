CREATE TABLE `conversation_resource_imports` (
	`source` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`rows` integer NOT NULL,
	`imported_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversation_resources` (
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`state` text NOT NULL,
	`generation` integer NOT NULL,
	`pending` text NOT NULL,
	PRIMARY KEY(`host_id`, `thread_id`),
	CONSTRAINT "conversation_resource_row" CHECK(length(host_id) BETWEEN 1 AND 1024
    AND length(thread_id) BETWEEN 1 AND 1024
    AND state IN ('active', 'archived', 'deleted')
    AND generation >= 1
    AND json_valid(pending) AND json_type(pending) = 'array')
) STRICT;
