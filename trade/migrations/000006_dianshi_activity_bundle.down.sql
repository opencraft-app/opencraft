-- 000006 dianshi-activity-bundle 数据模型回滚
--
-- 顺序：先 ALTER trade_order 移除 source 列 → 再 DROP 两张新表
--（trade_user_activity_participation / trade_bundle_activity 之间无 FK，DROP 顺序无要求）

ALTER TABLE trade_order DROP COLUMN source;

DROP TABLE IF EXISTS trade_user_activity_participation;
DROP TABLE IF EXISTS trade_bundle_activity;
