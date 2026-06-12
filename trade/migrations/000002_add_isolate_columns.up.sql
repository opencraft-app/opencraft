-- trade migration 0002：为 trade_flow 表加上 isolateResource / queryFlow 链路所需的列。
--
-- 设计稿对齐：.tmp/trade-pass-isolate-design.md
--   §3.2  trade_flow 改造点
--   §11 Q14 = a   isolate 链路 trade_flow 不绑 deal_name（jifei 协议入参不带 dealName）
--   §11 Q17 = d   uin 在 trade 侧统一 string；DB 落 VARCHAR(32) 与 trade_order.uin 对齐
--   §11 Q19 修订版 抢占式幂等：去掉 5min 时间窗口，改 SELECT FOR UPDATE 命中即回放
--   §11 Q21 = a1  ctl 调用失败 DELETE trade_flow 行回滚释放 slot
--
-- 改动点：
--   1. deal_name 改 NULL：isolate 链路 jifei 协议入参不带 dealName，必须允许 NULL
--      🔒 业务侧强约束：isolate 路径 INSERT 必须显式 deal_name = NULL，严禁空串等占位符；
--          单元测试 / reconcile 反查均依赖此 NULL 语义判定 isolate vs createResource 分支
--   2. resource_id VARCHAR(64) NULL：isolate 必填字段（= jifei resourceId = ctl pass_id），
--      createResource 链路不使用，落 NULL
--   3. uin VARCHAR(32) NULL：isolate 必填字段（= jifei uin），与 trade_order.uin 同型
--   4. idx_resource_isolate(resource_id, flow_type, status) 普通索引：
--      - 抢占式幂等的 SELECT FOR UPDATE 反查路径：WHERE resource_id=? AND flow_type='isolate_resource' AND status='in_progress'
--      - reconcile worker 兜底反查路径
--      - **非 UNIQUE**：同一 pass 在生命周期内可能多次到期 → 续费 → 再隔离，UNIQUE 会误阻塞合法重复
--
-- 兼容性：
--   - 存量行 deal_name 全部 NOT NULL 落值（createResource 链路），ALTER MODIFY 改 NULL 不影响
--   - 新加列默认 NULL，存量行无需 backfill
--   - 普通索引在北京 sandbox / shprod / sgprod trade_flow 表当前体量（< 1k 行）下 ALTER 秒级完成

ALTER TABLE trade_flow MODIFY COLUMN deal_name VARCHAR(64) NULL DEFAULT NULL
    COMMENT 'jifei dealName（createResource 链路必填；isolateResource 链路必为 NULL）';

ALTER TABLE trade_flow
    ADD COLUMN resource_id VARCHAR(64) NULL DEFAULT NULL
        COMMENT 'jifei resourceId（= ctl pass_id）；isolateResource 链路必填，createResource 链路落 NULL'
        AFTER app_id,
    ADD COLUMN uin VARCHAR(32) NULL DEFAULT NULL
        COMMENT 'jifei uin；isolateResource 链路必填（§11 Q14=a / Q17=d），createResource 链路可落 NULL'
        AFTER resource_id,
    ADD KEY idx_resource_isolate (resource_id, flow_type, status)
        COMMENT 'isolate 抢占式幂等 SELECT FOR UPDATE 反查 + reconcile worker 兜底（非 UNIQUE）';
