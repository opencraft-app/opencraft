-- v1.7.28 BUG-12 修复 (2026-05-21)：
-- 删除 trade_order.expire_time 列。
--
-- 背景：
-- - 列 schema 是 DATETIME NOT NULL，但 trade 业务层从未拥有"订单何时失效"的真源
--   （这本是 jifei 收银台的内部状态，trade 没必要镜像）。
-- - placeorder 写入时一直用 time.Time{} (Go zero value) 占位 → 落到 MySQL 是
--   '0000-00-00 00:00:00'，被 NO_ZERO_DATE sql_mode 拒（Error 1292 (22007)）。
-- - 用户拍板（2026-05-21 04:35）："可以把 trade_order 里的 expired_time 删了，
--   没啥用"。
--
-- 同步删除依赖该列的索引 idx_status_expire（status + expire_time 联合索引）；
-- 索引唯一用途是"扫描超时未支付订单清理"，目前没有此 worker 落地，未来如需要再
-- 重建（可改为 status + created_time）。
--
-- 列删除影响范围：
-- - trade store / placeorder logic / 测试 fixture 同步删 ExpireTime 字段
-- - 历史 trade_order 行的 expire_time 数据丢失（无业务价值，可接受）

ALTER TABLE trade_order DROP INDEX idx_status_expire;
ALTER TABLE trade_order DROP COLUMN expire_time;
