ALTER TABLE `personal_assistants` ADD `model_selection` text;--> statement-breakpoint
ALTER TABLE `personal_assistants` ADD `model_revision` integer DEFAULT 0 NOT NULL;