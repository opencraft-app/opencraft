-- 新增 credit 列（用户可见积分额度）
ALTER TABLE `bundle` ADD COLUMN `credit` BIGINT NOT NULL DEFAULT 0 AFTER `agent_quota`;

-- 新增套餐周期字段
ALTER TABLE `bundle` ADD COLUMN `time_span` INT NOT NULL DEFAULT 1 AFTER `credit`;
ALTER TABLE `bundle` ADD COLUMN `time_unit` VARCHAR(2) NOT NULL DEFAULT 'm' AFTER `time_span`;

-- 删除废弃的 monthly_tokens 列（由 credit × ratio 取代，Token 语义下沉至 ai-gateway Plan）
ALTER TABLE `bundle` DROP COLUMN `monthly_tokens`;
