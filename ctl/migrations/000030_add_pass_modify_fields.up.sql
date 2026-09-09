-- 为 pass 表新增同 SP 变配（升配）中间态字段。
--
-- 注意：000029 曾在历史北京测试库中用于网站迁移，虽然该文件后来从主线删除并合并进
-- 000028，但 schema_migrations 仍保留 version=29。因此本变更必须使用新的 000030，且
-- 对已经紧急补列的测试库保持幂等。
--
-- 需求：TAPD 1010132091137784162 §7.2「Pass 数据增加：status 增加 modifying / modify_flow_id /
-- modify_target_bundle_id」。
--
-- status 列无需 DDL：000019 已把它建成 VARCHAR(16)，'modifying'（9 字符）直接可用。

SET @modify_flow_id_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pass'
      AND COLUMN_NAME = 'modify_flow_id'
);
SET @modify_flow_id_ddl = IF(
    @modify_flow_id_exists = 0,
    'ALTER TABLE `pass` ADD COLUMN `modify_flow_id` BIGINT NOT NULL DEFAULT 0 COMMENT ''同 SP 变配在飞的 trade_flow.id；0 表示无变配进行中'' AFTER `status`',
    'SELECT 1'
);
PREPARE modify_flow_id_stmt FROM @modify_flow_id_ddl;
EXECUTE modify_flow_id_stmt;
DEALLOCATE PREPARE modify_flow_id_stmt;

SET @modify_target_bundle_id_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pass'
      AND COLUMN_NAME = 'modify_target_bundle_id'
);
SET @modify_target_bundle_id_ddl = IF(
    @modify_target_bundle_id_exists = 0,
    'ALTER TABLE `pass` ADD COLUMN `modify_target_bundle_id` VARCHAR(64) NOT NULL DEFAULT '''' COMMENT ''同 SP 变配的目标 bundle_id；空串表示无变配进行中'' AFTER `modify_flow_id`',
    'SELECT 1'
);
PREPARE modify_target_bundle_id_stmt FROM @modify_target_bundle_id_ddl;
EXECUTE modify_target_bundle_id_stmt;
DEALLOCATE PREPARE modify_target_bundle_id_stmt;
