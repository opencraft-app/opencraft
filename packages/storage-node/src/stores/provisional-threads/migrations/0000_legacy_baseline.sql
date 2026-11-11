CREATE TABLE `thread_creations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`result_json` text NOT NULL,
	`phase` text NOT NULL,
	`input_id` text,
	`turn_id` text,
	`environment_owner` text,
	CONSTRAINT "thread_creations_check_0" CHECK(phase IN ('created','attempted','accepted','persisted'))
) STRICT;
