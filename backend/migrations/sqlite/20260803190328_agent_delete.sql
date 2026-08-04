-- Add column "deleted_at" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `deleted_at` datetime NULL;
