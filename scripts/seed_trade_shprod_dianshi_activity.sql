-- shprod trade Dianshi activity seed.
--
-- Scope:
--   - Only writes trade.trade_bundle_activity.
--   - Enables the launch bundle activity mapping used by Beijing pre-release.
--   - Does not write trade_user_activity_participation, trade_order, pass, quota, or gateway data.
--
-- Secret handling:
--   - Dianshi production activity has signature verification enabled.
--   - Do not commit the real secret_key to Git. Before running this SQL, set the session variable
--     @dianshi_secret_key from the controlled runtime value, for example:
--       SET @dianshi_secret_key = '<dianshi activity secret>';
--       SET @dianshi_renew_secret_key = '<dianshi renew activity secret>';

START TRANSACTION;

INSERT INTO trade_bundle_activity
    (bundle_id, scene, activity_id, act_id, secret_key, active, time_span_unit, order_expired_time)
VALUES
    (
        'bundle_launch_01',
        'purchase',
        164273735574009,
        1881819452816580,
        NULLIF(@dianshi_secret_key, ''),
        1,
        '7d',
        1
    )
ON DUPLICATE KEY UPDATE
    activity_id = VALUES(activity_id),
    act_id = VALUES(act_id),
    secret_key = VALUES(secret_key),
    active = VALUES(active),
    time_span_unit = VALUES(time_span_unit),
    order_expired_time = VALUES(order_expired_time);

INSERT INTO trade_bundle_activity
    (bundle_id, scene, activity_id, act_id, secret_key, active, time_span_unit, order_expired_time)
VALUES
    (
        'bundle_launch_01',
        'renew',
        166165503931688,
        1975812517099088,
        NULLIF(@dianshi_renew_secret_key, ''),
        1,
        '1m',
        1
    )
ON DUPLICATE KEY UPDATE
    activity_id = VALUES(activity_id),
    act_id = VALUES(act_id),
    secret_key = VALUES(secret_key),
    active = VALUES(active),
    time_span_unit = VALUES(time_span_unit),
    order_expired_time = VALUES(order_expired_time);

SELECT bundle_id, scene, activity_id, act_id, active, time_span_unit, order_expired_time, secret_key IS NOT NULL AS has_secret
FROM trade_bundle_activity
WHERE bundle_id = 'bundle_launch_01' AND scene IN ('purchase', 'renew')
ORDER BY scene;

COMMIT;
