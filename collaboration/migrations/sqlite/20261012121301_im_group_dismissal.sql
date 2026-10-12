-- Add column "dismissed_by" to table: "im_groups"
ALTER TABLE `im_groups` ADD COLUMN `dismissed_by` text NULL;
-- Add column "dismiss_reason" to table: "im_groups"
ALTER TABLE `im_groups` ADD COLUMN `dismiss_reason` text NULL;
