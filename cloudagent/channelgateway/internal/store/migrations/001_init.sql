CREATE TABLE IF NOT EXISTS schema_migrations (
	version TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
	channel_account_id TEXT PRIMARY KEY,
	channel_type TEXT NOT NULL,
	tenant_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	config_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS channel_leases (
	channel_account_id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	fencing_token INTEGER NOT NULL,
	state TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	heartbeat_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_conversations (
	conversation_id TEXT PRIMARY KEY,
	channel_account_id TEXT NOT NULL,
	channel_type TEXT NOT NULL,
	external_conversation_id TEXT NOT NULL,
	external_user_id TEXT NOT NULL DEFAULT '',
	external_thread_id TEXT NOT NULL DEFAULT '',
	chat_type TEXT NOT NULL DEFAULT '',
	agent_id TEXT NOT NULL,
	acp_session_id TEXT NOT NULL DEFAULT '',
	session_key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE(channel_account_id, session_key)
);

CREATE INDEX IF NOT EXISTS channel_conversations_account_idx
ON channel_conversations(channel_account_id, updated_at);

CREATE TABLE IF NOT EXISTS channel_messages (
	message_id TEXT PRIMARY KEY,
	channel_account_id TEXT NOT NULL,
	channel_type TEXT NOT NULL,
	external_message_id TEXT NOT NULL,
	external_conversation_id TEXT NOT NULL,
	acp_session_id TEXT NOT NULL DEFAULT '',
	direction TEXT NOT NULL,
	status TEXT NOT NULL,
	payload_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(channel_account_id, external_message_id, direction)
);

CREATE INDEX IF NOT EXISTS channel_messages_session_idx
ON channel_messages(acp_session_id, created_at);

CREATE TABLE IF NOT EXISTS channel_outbox (
	outbox_id TEXT PRIMARY KEY,
	channel_account_id TEXT NOT NULL,
	channel_type TEXT NOT NULL,
	external_conversation_id TEXT NOT NULL,
	acp_session_id TEXT NOT NULL DEFAULT '',
	payload_json TEXT NOT NULL,
	status TEXT NOT NULL,
	claim_owner_id TEXT NOT NULL DEFAULT '',
	claim_fencing_token INTEGER NOT NULL DEFAULT 0,
	claimed_at TEXT,
	retry_count INTEGER NOT NULL DEFAULT 0,
	next_retry_at TEXT,
	last_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	sent_at TEXT
);

CREATE INDEX IF NOT EXISTS channel_outbox_pending_idx
ON channel_outbox(status, next_retry_at, created_at);
