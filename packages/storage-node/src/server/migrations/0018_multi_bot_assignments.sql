ALTER TABLE `personal_assistants` ADD `is_default` integer DEFAULT 1 NOT NULL CHECK(is_default IN (0,1));--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `duties` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `environment_json` text DEFAULT '{"kind":"local"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `config_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `paused` integer DEFAULT 0 NOT NULL CHECK(paused IN (0,1));--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `create_key` text;--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `create_fingerprint` text;--> statement-breakpoint
DROP INDEX `personal_assistants_owner_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_default_owner_unique` ON `personal_assistants` (`owner_human_id`) WHERE is_default=1;--> statement-breakpoint
CREATE UNIQUE INDEX `personal_assistants_create_key` ON `personal_assistants` (`owner_human_id`,`create_key`);
