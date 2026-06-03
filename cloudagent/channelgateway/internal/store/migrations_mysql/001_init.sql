CREATE TABLE IF NOT EXISTS schema_migrations (
	version VARCHAR(255) PRIMARY KEY,
	applied_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
	channel_account_id VARCHAR(191) PRIMARY KEY,
	channel_type VARCHAR(64) NOT NULL,
	tenant_id VARCHAR(191) NOT NULL,
	project_id VARCHAR(191) NOT NULL,
	agent_id VARCHAR(191) NOT NULL,
	config_json LONGTEXT NOT NULL,
	status VARCHAR(32) NOT NULL DEFAULT 'active',
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL,
	deleted_at VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_leases (
	channel_account_id VARCHAR(191) PRIMARY KEY,
	owner_id VARCHAR(191) NOT NULL,
	fencing_token BIGINT NOT NULL,
	state VARCHAR(32) NOT NULL,
	expires_at VARCHAR(64) NOT NULL,
	heartbeat_at VARCHAR(64) NOT NULL,
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_conversations (
	conversation_id VARCHAR(191) PRIMARY KEY,
	channel_account_id VARCHAR(191) NOT NULL,
	channel_type VARCHAR(64) NOT NULL,
	external_conversation_id VARCHAR(512) NOT NULL,
	external_user_id VARCHAR(191) NOT NULL DEFAULT '',
	external_thread_id VARCHAR(191) NOT NULL DEFAULT '',
	chat_type VARCHAR(64) NOT NULL DEFAULT '',
	agent_id VARCHAR(191) NOT NULL,
	acp_session_id VARCHAR(191) NOT NULL DEFAULT '',
	session_key VARCHAR(512) NOT NULL,
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL,
	deleted_at VARCHAR(64),
	UNIQUE KEY channel_conversations_account_session_key (channel_account_id, session_key),
	KEY channel_conversations_account_idx (channel_account_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_messages (
	message_id VARCHAR(191) PRIMARY KEY,
	channel_account_id VARCHAR(191) NOT NULL,
	channel_type VARCHAR(64) NOT NULL,
	external_message_id VARCHAR(191) NOT NULL,
	external_conversation_id VARCHAR(512) NOT NULL,
	acp_session_id VARCHAR(191) NOT NULL DEFAULT '',
	direction VARCHAR(32) NOT NULL,
	status VARCHAR(32) NOT NULL,
	payload_json LONGTEXT NOT NULL,
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL,
	UNIQUE KEY channel_messages_account_message_direction (channel_account_id, external_message_id, direction),
	KEY channel_messages_session_idx (acp_session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_outbox (
	outbox_id VARCHAR(191) PRIMARY KEY,
	channel_account_id VARCHAR(191) NOT NULL,
	channel_type VARCHAR(64) NOT NULL,
	external_conversation_id VARCHAR(512) NOT NULL,
	acp_session_id VARCHAR(191) NOT NULL DEFAULT '',
	payload_json LONGTEXT NOT NULL,
	status VARCHAR(32) NOT NULL,
	claim_owner_id VARCHAR(191) NOT NULL DEFAULT '',
	claim_fencing_token BIGINT NOT NULL DEFAULT 0,
	claimed_at VARCHAR(64),
	retry_count INT NOT NULL DEFAULT 0,
	next_retry_at VARCHAR(64),
	last_error TEXT NOT NULL,
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL,
	sent_at VARCHAR(64),
	KEY channel_outbox_pending_idx (status, next_retry_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
