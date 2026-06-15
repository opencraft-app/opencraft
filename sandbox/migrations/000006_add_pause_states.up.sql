-- Q26-D 修订版 + Q29=E5 + Q32=b 拍板 (2026-05-14)：trade pass isolation
-- 走"关机保留数据"路径，新增 instances.state 枚举值 'PAUSING' / 'PAUSED'。
--
-- 物理 schema：instances.state 是 VARCHAR(20)，原有定义已经能容纳 7-char
-- 'PAUSING' 和 6-char 'PAUSED'，因此本 migration 是 DDL no-op，仅用于审计
-- 与版本追踪。状态机的语义升级在 Go 侧（internal/core/types.go +
-- internal/service/pool.go::allowedTransitions）落地。
--
-- 状态机增量：
--   ALLOCATED → PAUSING → PAUSED       (pause 成功路径)
--   PAUSING   → ALLOCATED              (pause 失败回滚)
--   PAUSING   → FAILED                 (worker 兜底 stale 扫描)
--   PAUSED    → DELETING → DELETED     (后续销毁)
--   PAUSED    → FAILED                 (后续销毁失败)
--
-- 历史 hack 同步纠正：api-gin/handler.go::mapInstanceState 把 PAUSING/PAUSED
-- 都映射到 api.Paused，与历史 StateDry → api.Paused 共存（保留向后兼容）。

-- intentionally empty (no schema change required)
SELECT 1;
