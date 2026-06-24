-- 000007 回滚：trade_bundle_activity 删除 time_span_unit 列。
-- 配套 000007_trade_bundle_activity_time_span_unit.up.sql。

ALTER TABLE trade_bundle_activity
    DROP COLUMN time_span_unit;
