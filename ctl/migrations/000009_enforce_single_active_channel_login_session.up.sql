UPDATE channel_login_sessions AS older
JOIN channel_login_sessions AS newer
  ON older.user_id = newer.user_id
 AND older.instance_id = newer.instance_id
 AND older.channel = newer.channel
 AND older.status IN ('starting', 'waiting_qr', 'scanned')
 AND newer.status IN ('starting', 'waiting_qr', 'scanned')
 AND (
       older.created_at < newer.created_at
    OR (older.created_at = newer.created_at AND older.id < newer.id)
 )
SET older.status = 'expired',
    older.finished_at = COALESCE(older.finished_at, CURRENT_TIMESTAMP(3)),
    older.error_message = CASE
        WHEN older.error_message IS NULL OR older.error_message = '' THEN 'expired by migration before enforcing active-session uniqueness'
        ELSE older.error_message
    END;

ALTER TABLE `channel_login_sessions`
    ADD COLUMN `active_session_key` VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE
                WHEN `status` IN ('starting', 'waiting_qr', 'scanned')
                    THEN CONCAT(`user_id`, ':', `instance_id`, ':', `channel`)
                ELSE NULL
            END
        ) STORED,
    ADD UNIQUE KEY `uk_channel_login_active_session` (`active_session_key`);
