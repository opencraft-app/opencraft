ALTER TABLE channel_login_sessions
    ADD COLUMN bot_id VARCHAR(64) NOT NULL DEFAULT '' AFTER instance_id,
    ADD COLUMN profile_id VARCHAR(64) NOT NULL DEFAULT '' AFTER bot_id;
