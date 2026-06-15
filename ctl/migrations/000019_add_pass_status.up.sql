-- 为 pass 表新增 status 列（trade-pass-isolate 设计稿落地）
--
-- 拍板依据：.tmp/trade-pass-isolate-design.md
--   - Q8 = a：在 pass 表本身上加状态列（不再单独建 pass_status 表，避免跨表 JOIN）
--   - Q23 = C1 修订版：状态枚举设计为面向"隔离生命周期"的三档语义化值
--     * active     —— 默认值；pass 处于正常可用状态，CreateInstance 走绿灯
--     * isolating  —— IsolatePass 父 task 已 CAS 拿到锁，正在并行下发子 task 关停所有 instance
--     * isolated   —— 所有子 task finalize 成功，pass 维度的隔离闭环已完成（终态）
--   - 触发隔离的"门铃"由独立 isolated_time 列承担（已存在），status 列只表达"隔离生命周期阶段"
--   - 默认值 'active' 兜底所有存量 pass（包括 trial / 付费 / billing-integration 已上线场景）
--   - VARCHAR(16) 与 renew_flag 列容量一致，预留枚举扩展空间（如 'isolate_failed' 终态等）
--
-- 索引设计（Q23 = C1 修订版续）：
--   - idx_status 单列索引，供 reconcile worker 轮询 status='isolating' 的 stuck pass（30min 阈值）
--   - 不与 idx_user_id / idx_bundle_id 联合，避免索引膨胀；status 选择性低但 stuck 集合很小
--
-- ALTER 兼容性：
--   - DEFAULT 'active' 由 MySQL 在 ADD COLUMN 时一次性回填所有存量行，无需额外 backfill 脚本
--   - VARCHAR(16) 与 renew_flag 一致，存量 pass 表大小（截止 2026-05-14 北京 sandbox <100 行）下 ALTER 秒级完成
ALTER TABLE `pass`
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'active'
    COMMENT 'trade-pass-isolate Q23=C1：active（默认）/ isolating（隔离中）/ isolated（已隔离终态）';

CREATE INDEX `idx_status` ON `pass` (`status`);
