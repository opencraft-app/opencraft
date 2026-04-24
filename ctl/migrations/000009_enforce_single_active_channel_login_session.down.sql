ALTER TABLE `channel_login_sessions`
    DROP INDEX `uk_channel_login_active_session`,
    DROP COLUMN `active_session_key`;
