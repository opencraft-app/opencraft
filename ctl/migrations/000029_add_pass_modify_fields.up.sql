-- 为 pass 表新增同 SP 变配（升配）中间态字段
--
-- 需求：TAPD 1010132091137784162 §7.2「Pass 数据增加：status 增加 modifying / modify_flow_id /
-- modify_target_bundle_id」。
--
-- 为什么变配需要持久化 flow id，而 isolate / renew 只靠 status 占位就够：
--   计费侧 modifyResource 会持续重投同一个订单，此时必须返回原父任务；而 pass 已在
--   modifying 期间收到「另一个 flow」的请求必须拒绝（§8.1）。这两种情况的入参形状完全一样，
--   唯一的区分依据就是 pass 上记着的 in-flight flow id，因此它必须落库而不能只待在 task payload 里。
--
-- modify_target_bundle_id 同理：父 task 收尾要把 pass.bundle_id 切成目标套餐，运维排障也需要
-- 直接看到「这个 pass 正在升到哪个档」，不必去解 task_params JSON。
--
-- status 列无需 DDL：000019 已把它建成 VARCHAR(16)，'modifying'（9 字符）直接可用。
--
-- 默认值语义（非 NULL）：
--   - modify_flow_id = 0 表示没有在飞的变配；用 0 而非 NULL，让 CAS 的 WHERE 条件不必处理三值逻辑
--   - modify_target_bundle_id = '' 表示同上
--   存量行由 MySQL 在 ADD COLUMN 时一次性回填，无需额外 backfill 脚本。

ALTER TABLE `pass`
    ADD COLUMN `modify_flow_id` BIGINT NOT NULL DEFAULT 0
    COMMENT '同 SP 变配在飞的 trade_flow.id；0 表示无变配进行中'
    AFTER `status`,
    ADD COLUMN `modify_target_bundle_id` VARCHAR(64) NOT NULL DEFAULT ''
    COMMENT '同 SP 变配的目标 bundle_id；空串表示无变配进行中'
    AFTER `modify_flow_id`;
