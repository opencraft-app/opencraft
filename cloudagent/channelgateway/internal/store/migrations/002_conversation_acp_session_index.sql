CREATE INDEX IF NOT EXISTS channel_conversations_acp_session_idx
ON channel_conversations(channel_account_id, acp_session_id);
