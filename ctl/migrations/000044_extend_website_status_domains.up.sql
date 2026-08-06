-- 同步建站状态机的列注释，并为异步操作补充「死信」终态
--
-- 变更点：
-- 1. website_sites.status 增补 `deleting`（000037 起代码已在写，注释一直没跟上）
-- 2. website_operations.operation_type 增补 `suspend` / `resume`
--    （套餐到期下线 / 续费恢复改为走异步操作，不再只改 DB 状态）
-- 3. website_operations.status 增补 `dead`
--    终态死信：可重试操作达到最大尝试次数后停止重试，转人工介入，
--    避免 delete 类操作在环境不可达时无限重试。
--
-- 三列都是 VARCHAR，取值域由应用层约束，这里只改COMMENT（INPLACE，不重建数据）。

ALTER TABLE `website_sites`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'creating'
        COMMENT 'creating/active/suspended/deleting/deleted';

ALTER TABLE `website_operations`
    MODIFY COLUMN `operation_type` VARCHAR(32) NOT NULL
        COMMENT 'create/deploy/delete/suspend/resume',
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'created'
        COMMENT 'created/running/success/failed/dead';
