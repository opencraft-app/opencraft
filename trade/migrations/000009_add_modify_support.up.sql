-- trade migration 0009：为同 SP 变配（升配）链路修订 trade_order / trade_flow 的枚举 COMMENT。
--
-- 需求：TAPD 1010132091137784162 §7.1 Trade 改造
--
-- 本迁移只改 COMMENT，不加列、不加索引、不改类型：
--
--   1. trade_order.order_type 取值集加 'modify'。变配订单与新购/续费同表同列，
--      resource_id 复用为 pass_id（下单时即已知，与续费同源，不像新购要等发货回填）。
--   2. trade_flow.flow_type 取值集加 'modify_resource'，与 jifei 接口名
--      lightvela.pass.modifyResource 对偶。
--
-- 为什么不加列：
--   - 幂等键复用既有 uk_deal_flow_app (deal_name, flow_type, app_id)。变配必然带 dealName，
--     所以走 renew 的 TryAcquireSlot 范式即可，不需要 isolate/destroy 那套 dealName 可空的分支。
--   - 计费快照（source/target bundle、oldConfig/newConfig、curDeadline）整体落在既有
--     trade_order.goods_detail JSON 里。它本来就是"jifei goodsDetail 原样快照"，
--     为变配单开结构化列只会让同一份事实在两处漂移。
--   - trade 不保存 CTL 内部状态（Plan / AgentQuota / 实例快照），所以没有别的东西要存。
--
-- 兼容性：MODIFY COLUMN 仅改 COMMENT，不改类型与 NULL 性，不锁表。
-- down.sql 把 COMMENT 回滚到 0009 之前的措辞。

ALTER TABLE trade_order
    MODIFY COLUMN order_type VARCHAR(16) NOT NULL DEFAULT 'create'
        COMMENT '订单生命周期类型：create=新购 / renew=续费 / modify=变配 / 预留 refund 等';

ALTER TABLE trade_flow
    MODIFY COLUMN flow_type VARCHAR(32) NOT NULL
        COMMENT 'jifei 协议长事务流水类型：create_resource / isolate_resource / renew_resource / destroy_resource / transfer_resource / modify_resource（与 jifei 接口名 lightvela.pass.{createResource,isolateResource,renewResource,destroyResource,transferResource,modifyResource} 对偶；checkCreate / checkRenew / checkModify / queryFlow 不写本表）';
