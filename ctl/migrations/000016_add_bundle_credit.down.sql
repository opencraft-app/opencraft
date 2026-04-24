ALTER TABLE `bundle` ADD COLUMN `monthly_tokens` BIGINT NOT NULL DEFAULT 0 AFTER `ai_gateway_plan_id`;
ALTER TABLE `bundle` DROP COLUMN `time_unit`;
ALTER TABLE `bundle` DROP COLUMN `time_span`;
ALTER TABLE `bundle` DROP COLUMN `credit`;
