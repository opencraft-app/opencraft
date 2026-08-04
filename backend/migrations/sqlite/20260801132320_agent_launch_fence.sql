-- Add column "current_launch_id" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_id` text NULL;
-- Add column "current_launch_assignment_epoch" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_assignment_epoch` text NULL;
-- Add column "current_launch_generation" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_generation` integer NOT NULL DEFAULT (0);
-- Add column "current_launch_credential_version" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_credential_version` integer NOT NULL DEFAULT (0);
-- Add column "current_launch_attempt" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_attempt` integer NOT NULL DEFAULT (0);
-- Add column "current_launch_updated_at" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `current_launch_updated_at` datetime NULL;
