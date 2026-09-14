CREATE TABLE IF NOT EXISTS ctl_event_outbox (
    event_id VARCHAR(96) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(96) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(6) NOT NULL,
    lease_token VARCHAR(96) NULL,
    lease_expires_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    published_at DATETIME(6) NULL,
    last_error VARCHAR(1024) NULL,
    KEY idx_ctl_event_outbox_claim (status, next_attempt_at, lease_expires_at)
);
