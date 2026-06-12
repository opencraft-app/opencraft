-- 回滚 v1.7.28 BUG-12 列删除：恢复 expire_time + idx_status_expire 索引。
--
-- 注意：恢复后 expire_time 列允许 NULL（与 .up.sql 删除前的 NOT NULL 不一致），
-- 因为已经丢失的行无法重建 NOT NULL 约束所需的合法默认值。如果后续真的恢复
-- "订单失效"业务，placeorder 必须显式写入 NOW + 30min（或类似合理值）后再
-- 改回 NOT NULL（独立 migration）。

ALTER TABLE trade_order ADD COLUMN expire_time DATETIME NULL DEFAULT NULL COMMENT '支付订单失效时间（v1.7.28 BUG-12 回滚恢复，允许 NULL）';
ALTER TABLE trade_order ADD INDEX idx_status_expire (status, expire_time);
