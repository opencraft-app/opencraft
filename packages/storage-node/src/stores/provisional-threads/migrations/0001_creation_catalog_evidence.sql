ALTER TABLE `thread_creations` ADD COLUMN `catalog_state` text CHECK(catalog_state IN ('pending','retired'));
--> statement-breakpoint
ALTER TABLE `thread_creations` ADD COLUMN `catalog_only` integer NOT NULL DEFAULT 0 CHECK(catalog_only IN (0,1));
