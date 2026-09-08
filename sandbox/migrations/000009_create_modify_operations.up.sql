-- trade pass 同 SP 升配链路（启航 → 巡游 / 启航 AI → 巡游 AI）的 Sandbox 侧云操作账本。
--
-- 职责边界：本表只承载停机、计算规格升级、系统盘扩容、开机、目标 Pool 重绑等云侧步骤的
-- 持久化、幂等和续跑，不保存 Trade flow，也不是第二套业务流程。Pass / 实例的业务编排由
-- ctl 父子 task 负责。
--
-- idempotency_key 取 ctl 单实例 child task ID：同一 key 重复 POST 返回原 operation，
-- 已完成步骤不重复执行；这是不可逆磁盘扩容唯一的保护。
--
-- current_step 记录**已完成**的最后一个步骤（初始为空串），worker 据此续跑：
--   '' → stop_instance → resize_compute → resize_disk → start_instance
--      → verify_delivery → rebind_pool → done
--
-- instances.state 新增枚举值 'MODIFYING'（VARCHAR(20) 已能容纳，无需 DDL 变更）。
-- 状态机增量：ALLOCATED → MODIFYING → ALLOCATED。系统盘扩容不可逆，故无回滚边。

CREATE TABLE IF NOT EXISTS modify_operations (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL,
  sandbox_id VARCHAR(64) NOT NULL,
  instance_id VARCHAR(64) NOT NULL,
  source_pool_id VARCHAR(64) NOT NULL,
  target_pool_id VARCHAR(64) NOT NULL,
  target_sku_id VARCHAR(64) NOT NULL,
  target_template_class_id VARCHAR(64) NOT NULL DEFAULT '',
  target_instance_type VARCHAR(64) NOT NULL,
  target_system_disk_size INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL,
  current_step VARCHAR(64) NOT NULL DEFAULT '',
  last_error TEXT,
  started_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  UNIQUE KEY uniq_modify_operations_idempotency_key (idempotency_key),
  KEY idx_modify_operations_status (status),
  KEY idx_modify_operations_sandbox (sandbox_id),
  -- 一台实例同时只允许一份 running 账本：ctl 子 task 超时后父 task 会用新 key 重派，
  -- 那一轮必须复用在跑的账本而不是新开一份，否则两个 runner 会对同一台机器交错
  -- 下发停机 / 改配 / 扩盘。这个索引服务于 begin 前的"是否已有在跑账本"查询。
  KEY idx_modify_operations_instance_status (instance_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
