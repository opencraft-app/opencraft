-- 回滚 pass 变配中间态字段。
--
-- status 列不需要回滚：000019 建的是 VARCHAR(16) 而不是 ENUM，'modifying' 只是取值而非 schema。
-- 回滚前若仍有 status='modifying' 的行，需要先人工收敛，否则这些 pass 会失去目标套餐信息。

SET @modify_target_bundle_id_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pass'
      AND COLUMN_NAME = 'modify_target_bundle_id'
);
SET @modify_target_bundle_id_ddl = IF(
    @modify_target_bundle_id_exists > 0,
    'ALTER TABLE `pass` DROP COLUMN `modify_target_bundle_id`',
    'SELECT 1'
);
PREPARE modify_target_bundle_id_stmt FROM @modify_target_bundle_id_ddl;
EXECUTE modify_target_bundle_id_stmt;
DEALLOCATE PREPARE modify_target_bundle_id_stmt;

SET @modify_flow_id_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pass'
      AND COLUMN_NAME = 'modify_flow_id'
);
SET @modify_flow_id_ddl = IF(
    @modify_flow_id_exists > 0,
    'ALTER TABLE `pass` DROP COLUMN `modify_flow_id`',
    'SELECT 1'
);
PREPARE modify_flow_id_stmt FROM @modify_flow_id_ddl;
EXECUTE modify_flow_id_stmt;
DEALLOCATE PREPARE modify_flow_id_stmt;
