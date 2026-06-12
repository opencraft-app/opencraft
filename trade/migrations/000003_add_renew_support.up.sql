-- trade migration 0003：为 trade_order / trade_flow 表加上 renewResource 链路所需的列与 COMMENT 修订。
--
-- 设计稿对齐：.tmp/trade-pass-renew-design.md
--   §4.2  trade_flow / trade_order 表 migration 0003
--   §12 Q7=a    续费落 trade_order，order_type='renew'，与新购同表共用
--   §12 Q15=a   trade_flow.deal_name 三态强约束（NULL / 非空字符串 / 不可改）— store 层 panic assertion 落地
--   §12 Q18=a   migration 0003 部署顺序约束：先 R-A migration 后 R-C 业务代码
--   §12 Q19=b   全链路（新购 + 续费）放开 time_unit ∈ {m, d, y}
--
-- 改动点：
--   1. trade_order ADD COLUMN order_type VARCHAR(16) NOT NULL DEFAULT 'create' — 区分 create/renew 订单
--      - **维度独立**：trade_order.order_type（订单生命周期类型，取值 create/renew/refund 短词）与
--        trade_flow.flow_type（jifei 协议长事务流水类型，取值 create_resource/isolate_resource/renew_resource）
--        是不同表的不同列、不同维度、不同命名风格，详见设计稿 §4.2 字段维度对照表。
--      - default 'create' 兼容历史数据：现有新购落库代码不需改动，新购订单默认 order_type='create'
--      - 续费 PlaceRenewOrder 写入时显式指定 order_type='renew' + resource_id=passID（复用现有 resource_id 列）
--      - 续费历史反查走 idx_resource (resource_type, resource_id) 索引 + WHERE order_type='renew' 二级筛选
--        二级筛选选择性足够，不再单独加 (resource_id, order_type) 索引
--   2. trade_order MODIFY COLUMN time_unit COMMENT — 取值集从 'm/y' 扩展为 'm/d/y'（Q19=b 联动）
--      - 数据无变化（VARCHAR 类型不动），仅 COMMENT 修订
--   3. trade_flow MODIFY COLUMN flow_type COMMENT — 枚举值列表更新为全集
--      - 旧 COMMENT：'Q62 收敛：本期仅 create_resource 一类'（migration 0001 / 0002 未同步修订）
--      - 新 COMMENT：覆盖 create_resource / isolate_resource / renew_resource 三态全集
--
-- 兼容性：
--   - trade_order ADD COLUMN 带 NOT NULL DEFAULT 'create'，存量行自动落 'create'，无需 backfill
--   - MODIFY COLUMN COMMENT 不改类型与 NULL 性，不锁表（北京 sandbox / shprod / sgprod 体量 < 10k 行，秒级完成）
--   - down.sql 仅回滚 ADD COLUMN，不回滚 COMMENT 修订（COMMENT 是文档级元数据，不影响数据完整性）

ALTER TABLE trade_order
    ADD COLUMN order_type VARCHAR(16) NOT NULL DEFAULT 'create'
        COMMENT '订单生命周期类型：create=新购 / renew=续费 / 预留 refund 等'
        AFTER bundle_id,
    MODIFY COLUMN time_unit VARCHAR(8) NOT NULL
        COMMENT '购买时长单位 m/d/y（与 jifei goodsDetail.timeUnit 对应；Q19=b 全链路放开 m/d/y）';

ALTER TABLE trade_flow
    MODIFY COLUMN flow_type VARCHAR(32) NOT NULL
        COMMENT 'jifei 协议长事务流水类型：create_resource / isolate_resource / renew_resource（与 jifei 接口名 lightvela.pass.{createResource,isolateResource,renewResource} 对偶；checkCreate / queryFlow 不写本表）';
