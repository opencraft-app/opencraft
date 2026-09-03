-- 回滚 pass 变配中间态字段。
--
-- status 列不需要回滚：000019 建的是 VARCHAR(16) 而不是 ENUM，'modifying' 只是取值而非 schema。
-- 回滚前若仍有 status='modifying' 的行，需要先人工收敛，否则这些 pass 会失去目标套餐信息。

ALTER TABLE `pass`
    DROP COLUMN `modify_target_bundle_id`,
    DROP COLUMN `modify_flow_id`;
