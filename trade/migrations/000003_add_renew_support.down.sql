-- trade migration 0003 down.sql：回滚 renewResource 链路所需的列与 COMMENT 修订。
--
-- 注意：
--   - 仅回滚 ADD COLUMN order_type；MODIFY COLUMN COMMENT 是文档级元数据，不影响数据完整性，down.sql 不回滚。
--   - 如果生产已有 trade_order.order_type='renew' 行（续费已上线），down 会丢失这部分数据；
--     正常回滚路径仅在测试环境 / 未上线前使用。
--   - 同理 trade_flow.flow_type='renew_resource' 行如已存在，down.sql 不会清理这些行。

ALTER TABLE trade_order
    DROP COLUMN order_type;
