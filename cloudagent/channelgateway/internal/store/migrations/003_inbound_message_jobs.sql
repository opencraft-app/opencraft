ALTER TABLE channel_messages ADD COLUMN claim_owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE channel_messages ADD COLUMN claim_fencing_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_messages ADD COLUMN claimed_at TEXT;
ALTER TABLE channel_messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_messages ADD COLUMN next_retry_at TEXT;
ALTER TABLE channel_messages ADD COLUMN last_error TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS channel_messages_inbound_pending_idx
ON channel_messages(channel_account_id, direction, status, next_retry_at, updated_at);
