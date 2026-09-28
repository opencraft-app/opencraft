-- 000011 回滚会删除续费活动配置和续费参与事实，只能在完成备份并明确接受数据丢失后执行。

DELETE FROM trade_bundle_activity WHERE scene = 'renew';
DELETE FROM trade_user_activity_participation WHERE scene = 'renew';

ALTER TABLE trade_order
    DROP INDEX idx_dianshi_reusable_order,
    ADD INDEX idx_dianshi_reusable_order
        (external_user_id, activity_id, bundle_id, source, status, created_time);

ALTER TABLE trade_user_activity_participation
    DROP INDEX uk_uin_activity_scene,
    DROP INDEX idx_external_user_scene,
    ADD UNIQUE KEY uk_uin_activity (uin, activity_id),
    ADD KEY idx_external_user (external_user_id, activity_id),
    DROP COLUMN scene;

ALTER TABLE trade_bundle_activity
    DROP INDEX uk_bundle_scene,
    DROP INDEX idx_scene_activity,
    ADD UNIQUE KEY bundle_id (bundle_id),
    DROP COLUMN scene;
