-- 000008 dianshi PlaceOrder idempotency（设计稿 .tmp/dianshi-activity-bundle-design.md v0.6）
--
-- 目标：
--   1. trade_bundle_activity 增加 order_expired_time，单位小时，支持 0.5，默认 1。
--   2. trade_order 落点石 activity_id / act_id，支持按 user+activity+bundle 查找有效中态订单。
--   3. 增加复用查询索引，避免重复点击时再次调点石 do_goods。
--
-- 作用域：仅点石新购下单幂等；普通 jifei 下单幂等后续单独设计。

ALTER TABLE trade_bundle_activity
    ADD COLUMN order_expired_time FLOAT NOT NULL DEFAULT 1
        COMMENT '点石下单幂等复用窗口，单位小时，支持 0.5；仅点石新购生效'
        AFTER time_span_unit;

ALTER TABLE trade_order
    ADD COLUMN activity_id BIGINT NOT NULL DEFAULT 0
        COMMENT '点石活动大 ID；非点石订单为 0'
        AFTER source,
    ADD COLUMN act_id BIGINT NOT NULL DEFAULT 0
        COMMENT '点石商品大 ID；非点石订单为 0'
        AFTER activity_id,
    ADD INDEX idx_dianshi_reusable_order
        (external_user_id, activity_id, bundle_id, source, status, created_time);
