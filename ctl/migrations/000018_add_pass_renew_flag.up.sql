-- 为 pass 表新增 renew_flag 列（v4 收敛：billing-integration 子需求 B2）
-- 字段说明：
--   - 类型 VARCHAR(16)，未来扩展枚举值方便（不用 TINYINT bool）
--   - 默认值 'MANUAL_RENEW'（v4 收敛默认值，对齐 jifei autoRenewFlag=0 不自动续费）
--   - 取值枚举：MANUAL_RENEW（手动续费，默认）/ AUTO_RENEW（自动续费，本期不暴露）
--   - 试用 pass 走 CreateTrialPass / CreatePassOrder 链路不显式写该列，靠默认值兜底
--   - 付费 pass 走 CompletePass 链路由 logic 内部写死 MANUAL_RENEW（本期不对外暴露）
ALTER TABLE `pass`
    ADD COLUMN `renew_flag` VARCHAR(16) NOT NULL DEFAULT 'MANUAL_RENEW'
    COMMENT 'v4 收敛枚举：MANUAL_RENEW（默认 / 手动续费）/ AUTO_RENEW（自动续费，本期不暴露）';
