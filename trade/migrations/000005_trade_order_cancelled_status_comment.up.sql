-- 文档型 migration（v1.7.32 新增订单状态查询接口）：
--
-- 业务背景：trade 新增 orderstatus.QueryStatus（POST /internal/trade/orders/:deal/query-status），
-- 当 jifei.getDealsByKeyIndex 反查到订单状态为 canceled / overdue / delete 时，
-- trade 内部 CAS UPDATE trade_order.status='cancelled' 推进本地终态。
--
-- 设计稿对齐：.tmp/ctl-order-status-query-design.md §1 不变量 B2 / B6 + §3.2 状态枚举映射 + Q-OS-4 拍板：
--   - VARCHAR(32) 已能存 'cancelled'，**无需 ALTER 列类型 / 默认值**；
--   - 仅更新列 COMMENT 让 schema 元信息与代码一致，便于 DBA / 运维查表时一眼看到完整状态机。
--
-- 与既有 status 状态机的关系：
--   created / pending_pay → paid_pending_provision → provisioned    ✅ 终态
--                                                  ↘ payment_failed   ✅ 终态（预留）
--                                                  ↘ provision_failed ✅ 终态（预留）
--                                                  ↘ cancelled        ✅ 终态（v1.7.32 新增）
--
-- 仅改 COMMENT，不改字段类型 / 默认值 / 索引；运行此 migration 等价于 schema 元信息文档更新。

ALTER TABLE trade_order
    MODIFY COLUMN status VARCHAR(32) NOT NULL
    COMMENT '状态机：created / pending_pay / paid_pending_provision / provisioned / payment_failed / provision_failed / cancelled (v1.7.32)';
