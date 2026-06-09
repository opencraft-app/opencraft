ALTER TABLE channel_messages ADD COLUMN claim_owner_id VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE channel_messages ADD COLUMN claim_fencing_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE channel_messages ADD COLUMN claimed_at VARCHAR(64);
ALTER TABLE channel_messages ADD COLUMN retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE channel_messages ADD COLUMN next_retry_at VARCHAR(64);
ALTER TABLE channel_messages ADD COLUMN last_error TEXT;

CREATE INDEX channel_messages_inbound_pending_idx
ON channel_messages(channel_account_id, direction, status, next_retry_at, updated_at);
