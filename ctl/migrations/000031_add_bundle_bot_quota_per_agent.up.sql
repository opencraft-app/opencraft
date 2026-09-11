ALTER TABLE `bundle`
    ADD COLUMN `bot_quota_per_agent` BIGINT NOT NULL DEFAULT 1
        COMMENT 'maximum Hermes Profiles per Agent, including the root profile'
        AFTER `agent_quota`;

UPDATE `bundle`
SET `bot_quota_per_agent` = 5
WHERE `bundle_id` IN ('bundle_launch_01', 'bundle_launch_ai_01');

UPDATE `bundle`
SET `bot_quota_per_agent` = 10
WHERE `bundle_id` IN ('bundle_cruise_01', 'bundle_cruise_ai_01');
