-- 文档型 migration 回滚：把 status 列 COMMENT 还原回 migration 0001 初始版本。
--
-- 注意：down 仅回滚 COMMENT 文本；如果生产 DB 已有 status='cancelled' 的真实数据行，
-- 该列值不会被 down 清理（schema 上 VARCHAR(32) 仍能容纳 'cancelled' 字符串）。
-- 真要回滚业务时，请在应用层另写 DML 把 'cancelled' 行改为合适的中态，再跑本 down。

ALTER TABLE trade_order
    MODIFY COLUMN status VARCHAR(32) NOT NULL
    COMMENT '状态机：created / pending_pay / paid_pending_provision / provisioned / payment_failed / provision_failed';
