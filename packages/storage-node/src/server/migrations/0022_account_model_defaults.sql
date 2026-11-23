CREATE TABLE `account_model_defaults` (
	`actor_id` text NOT NULL,
	`host_id` text NOT NULL,
	`revision` integer NOT NULL,
	`format` integer NOT NULL,
	`selection` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`actor_id`, `host_id`),
	CONSTRAINT "account_model_defaults_revision" CHECK(revision > 0)
) STRICT;
