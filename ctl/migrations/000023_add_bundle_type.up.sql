-- 新增 bundle_type 字段（套餐分类，Q-BUNDLE-TYPE 拍板）
-- 取值枚举（代码层 IsValidBundleType 校验，仅以下三种合法值）：
--   free    : 免费套餐（bundle_id 以 'bundle_free_trial' 开头）
--   ai      : AI 套餐  （bundle_id 含 '_ai_' 段，如 bundle_launch_ai_01）
--   general : 通用付费套餐（其它，如 bundle_launch_01）
--
-- 该字段是 user-facing 面向用户的套餐查询接口 (GET /v1/bundles) 的出参字段之一，
-- 前端按 bundle_type 区分套餐展示样式 / 折扣徽章 / 跳转入口。
--
-- 历史数据处理策略：本 migration **不自动 backfill**，新列默认值 '' 占位即可；
-- 运营 / 研发后续按需通过业务面 UPDATE 接口或直接 SQL 维护：
--   UPDATE `bundle` SET `bundle_type` = 'free'    WHERE `bundle_id` LIKE 'bundle_free_trial%';
--   UPDATE `bundle` SET `bundle_type` = 'ai'     WHERE `bundle_id` LIKE '%_ai_%';
--   UPDATE `bundle` SET `bundle_type` = 'general' WHERE `bundle_type` = '';
-- 这样可以人工核对每条 bundle 的归类，避免 LIKE 通配符在边界 bundle 上误判。
ALTER TABLE `bundle`
    ADD COLUMN `bundle_type` VARCHAR(64) NOT NULL DEFAULT ''
    COMMENT '套餐分类：free=免费 / general=通用付费 / ai=AI 套餐' AFTER `bundle_id`;
