-- 建站创建接口的真实幂等键
--
-- 000029 之前没有这一列，DAO 退化成用 `name` 字段冒充幂等键：
-- Agent 按常规传UUID 时永远命中不到，重试会重复建站并重复扣席位。
-- 这里补上真实列+ (user_id, idempotency_key) 唯一索引，
-- 由 DB 层保证「同一用户同一幂等键最多一个站点」。
--
-- 允许 NULL：不传幂等键的请求不参与去重（MySQL 唯一索引不对 NULL 去重）。

ALTER TABLE `website_sites`
    ADD COLUMN `idempotency_key` VARCHAR(64) DEFAULT NULL COMMENT '创建幂等键，同一用户内唯一' AFTER `name`,
    ADD UNIQUE KEY `uk_user_idempotency` (`user_id`, `idempotency_key`);
