-- 新增 ai_gateway_plans JSON 列（DB 内部字段，多对多 plan 关系，Q37/Q38 拍板）
-- 唯一消费方：ctl/pass.CompletePaidPassFromJifei 按 period 选 plan_id；
-- trade 不感知该字段；ctl 任何 user-facing / internal-facing 出参一律不暴露。
-- 格式：[{"plan_id":"plan-xxx","quota_per_period":1000000}, ...]
ALTER TABLE `bundle` ADD COLUMN `ai_gateway_plans` JSON NULL
    COMMENT 'ai-gateway plan 列表，多对多关系（Q37/Q38）。格式 [{"plan_id":"...","quota_per_period":N}]。DB 内部字段，仅 ctl/pass 消费' AFTER `ai_gateway_plan_id`;
