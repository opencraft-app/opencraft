ALTER TABLE channel_conversations ADD COLUMN runtime_closed_at TEXT;

CREATE INDEX IF NOT EXISTS channel_conversations_idle_open_idx
ON channel_conversations(channel_account_id, runtime_closed_at, updated_at);
