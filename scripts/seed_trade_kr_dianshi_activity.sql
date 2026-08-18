START TRANSACTION;

DROP TEMPORARY TABLE IF EXISTS dianshi_secret_key_validation;

CREATE TEMPORARY TABLE dianshi_secret_key_validation (
    secret_key VARCHAR(128) NOT NULL
);

INSERT INTO dianshi_secret_key_validation (secret_key)
SELECT NULLIF(@dianshi_secret_key, '');

INSERT INTO trade_bundle_activity
    (bundle_id, activity_id, act_id, secret_key, active, time_span_unit, order_expired_time)
SELECT 'bundle_launch_01', 165523570799387, 142062575174494,
       secret_key, 1, '14d', 1
FROM dianshi_secret_key_validation
ON DUPLICATE KEY UPDATE
    activity_id = VALUES(activity_id),
    act_id = VALUES(act_id),
    secret_key = VALUES(secret_key),
    active = VALUES(active),
    time_span_unit = VALUES(time_span_unit),
    order_expired_time = VALUES(order_expired_time);

SELECT bundle_id, activity_id, act_id, active, time_span_unit,
       order_expired_time, secret_key IS NOT NULL AS has_secret
FROM trade_bundle_activity
WHERE bundle_id = 'bundle_launch_01';

DROP TEMPORARY TABLE dianshi_secret_key_validation;

COMMIT;
