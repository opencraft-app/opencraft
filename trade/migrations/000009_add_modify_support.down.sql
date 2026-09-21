-- 回滚 trade migration 0009：把 order_type / flow_type 的 COMMENT 恢复到 0009 之前的措辞。
--
-- 数据不受影响：0009 只改 COMMENT。已写入的 'modify' / 'modify_resource' 行在回滚后
-- 仍然存在且可读，只是 COMMENT 不再列出这两个取值。

ALTER TABLE trade_order
    MODIFY COLUMN order_type VARCHAR(16) NOT NULL DEFAULT 'create'
        COMMENT '订单生命周期类型：create=新购 / renew=续费 / 预留 refund 等';

ALTER TABLE trade_flow
    MODIFY COLUMN flow_type VARCHAR(32) NOT NULL
        COMMENT 'jifei 协议长事务流水类型：create_resource / isolate_resource / renew_resource（与 jifei 接口名 lightvela.pass.{createResource,isolateResource,renewResource} 对偶；checkCreate / queryFlow 不写本表）';
