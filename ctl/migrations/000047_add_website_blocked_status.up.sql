-- 站点状态增补 `blocked`（违规封禁）
--
-- 与 suspended 的区别：suspended 是套餐到期，续费即恢复；blocked 是我们主动停用，
-- 不随套餐状态变化，需人工解除。
--
-- 引入这个状态是为了让站点网关能秒级拦截违规站点，而不必等待删除产物。
-- 用户生成内容共用一个 COS 桶，先于云厂商动手下线是避免处罚从对象级升级到
-- 桶级（进而波及全体用户站点）的关键手段。
--
-- status 是 VARCHAR，取值域由应用层约束，这里只改 COMMENT（INPLACE，不重建数据）。

ALTER TABLE `website_sites`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'creating'
        COMMENT 'creating/active/suspended/blocked/deleting/deleted';
