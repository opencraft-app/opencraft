-- 000007 trade_bundle_activity 加 time_span_unit 列（设计稿 .tmp/dianshi-activity-bundle-design.md §3.1 / §5.1）
--
-- 背景：联调期实测发现，点石询价 / 下单 envelope.interface.para.goods[].preference_param
-- 必传 4 个字段 {regionId, timeSpanUnit, subProductCode, bundleId}，否则点石侧返
-- returnCode=1100109 缺少参数 / 1100105 商品ID不存在。其中：
--   - bundleId      = trade_bundle_activity.bundle_id（已有列）
--   - subProductCode = trade_bundle_definition.sub_product_code（已有列）
--   - regionId      = trade 端 LIGHTVELA_TRADE_REGION env 经 region.Resolve() 映射的 RegionID
--   - timeSpanUnit  = 启航 01="7d" / 启航 AI 01 待实测；不同 bundle 字面值不同
--
-- 本 migration 把 timeSpanUnit 抽为 trade_bundle_activity 表的列，避免 trade 代码硬编码。
-- 运营在每个环境部署后手工 INSERT trade_bundle_activity 行时，必须按点石后台的实际配置
-- 填具体字面值（如 "7d" / "14d"）；新加列对已有行用 DEFAULT '' 兼容，运营再 UPDATE 补真值。

ALTER TABLE trade_bundle_activity
    ADD COLUMN time_span_unit VARCHAR(32) NOT NULL DEFAULT ''
    COMMENT '点石询价 / 下单 preference_param.timeSpanUnit 字面值（如 "7d"），由运营按 bundle 在点石后台的实际注册配置 INSERT 时填入。空字符串表示该 bundle 在点石侧未要求 timeSpanUnit（联调期 fallback）。';
