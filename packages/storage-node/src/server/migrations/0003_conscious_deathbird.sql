CREATE TABLE `conversation_catalogs` (
	`scope` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`sync_state` text NOT NULL,
	CONSTRAINT "conversation_catalog_revision" CHECK(typeof(revision)='integer' AND revision>=0),
	CONSTRAINT "conversation_catalog_state" CHECK(json_valid(sync_state) AND json_type(sync_state)='object')
) STRICT;
--> statement-breakpoint
ALTER TABLE `conversation_threads` ADD `model_version` integer DEFAULT 0 NOT NULL;