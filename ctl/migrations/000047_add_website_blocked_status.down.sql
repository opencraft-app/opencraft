-- 回滚 `blocked` 状态的注释增补。
--
-- 只还原 COMMENT，不改数据：已经处于 blocked 的站点必须保持封禁，
-- 回滚迁移不应该把违规站点重新放出来。

ALTER TABLE `website_sites`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'creating'
        COMMENT 'creating/active/suspended/deleting/deleted';
