-- 套餐展示化改造：功能特性列表 / 一句话卖点 / 促销角标 由 bundle 配置下发，
-- 替代订阅页前端硬编码（PRD 2026-07-14 功能点 3/6/7）。
--
-- 三列均为 user-facing (GET /v1/bundles) 出参，纯展示字段：
--   - 不参与 trade 询价、不影响下单链路；
--   - internal RPC (InternalBundleDetail) 不暴露。
--
-- 历史数据不 backfill：features / promotion 为 NULL、tagline 为空串时，
-- 前端回退到既有硬编码兜底逻辑（保证灰度期不炸）。
ALTER TABLE `bundle`
    ADD COLUMN `features`  JSON         NULL COMMENT '功能特性列表 JSON：[{"key","label","value","included","highlight"}]' AFTER `description`,
    ADD COLUMN `tagline`   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '套餐一句话卖点文案' AFTER `features`,
    ADD COLUMN `promotion` JSON         NULL COMMENT '促销角标 JSON：{"label","kind","discount","first_period_only"}；无促销为 NULL' AFTER `tagline`;
