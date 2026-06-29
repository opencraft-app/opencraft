-- 000008 rollback：删除点石下单幂等相关列和索引。

ALTER TABLE trade_order
    DROP INDEX idx_dianshi_reusable_order,
    DROP COLUMN act_id,
    DROP COLUMN activity_id;

ALTER TABLE trade_bundle_activity
    DROP COLUMN order_expired_time;
