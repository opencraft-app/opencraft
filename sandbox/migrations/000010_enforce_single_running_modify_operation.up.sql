-- 一台实例只能有一份 running 变配账本。
--
-- 000009 最初只有普通 (instance_id, status) 索引；两个不同 ctl child task 并发时，
-- “先查 running、再 INSERT”无法形成原子约束。这里通过生成列把 running 行投影为
-- instance_id、终态行投影为 NULL。MySQL unique index 允许多个 NULL，因此既保留完整
-- 历史，又从数据库层阻止两份 running 账本并存。
--
-- 如果旧库已经存在重复 running 账本，下面的原子 ALTER 会因唯一键冲突失败并保持原
-- 数据不变。不能按创建时间自动选择保留项：不同账本可能指向不同目标或已有不同云侧
-- 进度。此时发布必须 fail closed，由 owner 核对目标和步骤后显式隔离冲突项，再重试。

ALTER TABLE modify_operations
  ADD COLUMN running_instance_id VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE WHEN status = 'running' THEN instance_id ELSE NULL END
    ) STORED,
  ADD UNIQUE KEY uniq_modify_operations_running_instance (running_instance_id);
