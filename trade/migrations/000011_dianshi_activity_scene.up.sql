-- 000011 点石活动按新购/续费场景隔离。
--
-- 发布顺序：先执行本 migration，再发布 scene-aware Trade；在旧 Trade 下线前不要插入 renew 行。

ALTER TABLE trade_bundle_activity
    ADD COLUMN scene VARCHAR(16) NOT NULL DEFAULT 'purchase'
        COMMENT '活动场景：purchase=新购，renew=续费'
        AFTER bundle_id,
    DROP INDEX bundle_id,
    ADD UNIQUE KEY uk_bundle_scene (bundle_id, scene),
    ADD KEY idx_scene_activity (scene, activity_id, active);

ALTER TABLE trade_user_activity_participation
    ADD COLUMN scene VARCHAR(16) NOT NULL DEFAULT 'purchase'
        COMMENT '活动场景：purchase=新购，renew=续费'
        AFTER activity_id,
    DROP INDEX uk_uin_activity,
    ADD UNIQUE KEY uk_uin_activity_scene (uin, activity_id, scene),
    DROP INDEX idx_external_user,
    ADD KEY idx_external_user_scene (external_user_id, activity_id, scene);

ALTER TABLE trade_order
    DROP INDEX idx_dianshi_reusable_order,
    ADD INDEX idx_dianshi_reusable_order
        (external_user_id, activity_id, order_type, bundle_id, source, status, created_time);
