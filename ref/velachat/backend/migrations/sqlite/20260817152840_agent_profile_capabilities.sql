-- Add column "profile_capability_refresh_id" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `profile_capability_refresh_id` text NULL;
-- Add column "profile_capabilities_json" to table: "agents"
ALTER TABLE `agents` ADD COLUMN `profile_capabilities_json` text NULL;
