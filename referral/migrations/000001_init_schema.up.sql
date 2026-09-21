-- Initial Beijing referral campaign and reward state.
CREATE TABLE referral_campaign (
    campaign_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL,
    starts_at DATETIME(6) NOT NULL,
    ends_at DATETIME(6) NOT NULL,
    inviter_credit BIGINT NOT NULL,
    invitee_credit BIGINT NOT NULL,
    vesting_days INT NOT NULL DEFAULT 7,
    pending_ttl_days INT NOT NULL DEFAULT 90,
    max_rewards_per_inviter INT NOT NULL DEFAULT 50,
    budget_credit BIGINT NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    KEY idx_referral_campaign_active (status, starts_at, ends_at)
);

CREATE TABLE referral_code (
    code VARCHAR(32) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    owner_user_id VARCHAR(64) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_code_owner (campaign_id, owner_user_id),
    KEY idx_referral_code_campaign (campaign_id)
);

CREATE TABLE referral_attribution (
    attribution_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    invitee_user_id VARCHAR(64) NOT NULL,
    inviter_user_id VARCHAR(64) NOT NULL,
    referral_code VARCHAR(32) NOT NULL,
    registration_event_id VARCHAR(96) NOT NULL,
    registered_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_attribution_invitee (campaign_id, invitee_user_id),
    UNIQUE KEY uk_referral_attribution_event (registration_event_id),
    KEY idx_referral_attribution_inviter (campaign_id, inviter_user_id)
);

CREATE TABLE referral_first_paid_fact (
    pass_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(96) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    bundle_id VARCHAR(128) NOT NULL,
    deal_name VARCHAR(128) NOT NULL,
    paid_at DATETIME(6) NOT NULL,
    refunded_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_first_paid_event (event_id),
    KEY idx_referral_first_paid_user (user_id, paid_at)
);

CREATE TABLE referral_refund_fact (
    pass_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(96) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    deal_name VARCHAR(128) NOT NULL,
    refunded_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_refund_event (event_id),
    KEY idx_referral_refund_user (user_id, refunded_at)
);

CREATE TABLE referral_event_inbox (
    event_id VARCHAR(96) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    producer VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(96) NOT NULL,
    correlation_id VARCHAR(96) NOT NULL,
    occurred_at DATETIME(6) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    received_at DATETIME(6) NOT NULL,
    processed_at DATETIME(6) NOT NULL,
    KEY idx_referral_inbox_type_time (event_type, occurred_at)
);

CREATE TABLE referral_reward (
    reward_id VARCHAR(64) PRIMARY KEY,
    campaign_id VARCHAR(64) NOT NULL,
    invitee_user_id VARCHAR(64) NOT NULL,
    qualifying_pass_id VARCHAR(64) NOT NULL,
    beneficiary_user_id VARCHAR(64) NOT NULL,
    reward_side VARCHAR(16) NOT NULL,
    credit_amount BIGINT NOT NULL,
    idempotency_key VARCHAR(191) NOT NULL,
    status VARCHAR(24) NOT NULL,
    eligible_at DATETIME(6) NOT NULL,
    grant_deadline DATETIME(6) NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(6) NOT NULL,
    lease_owner VARCHAR(96) NULL,
    lease_expires_at DATETIME(6) NULL,
    subscription_id VARCHAR(128) NULL,
    subscription_name VARCHAR(191) NULL,
    last_error_code VARCHAR(128) NULL,
    last_error_message VARCHAR(1024) NULL,
    granted_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_reward_side (campaign_id, invitee_user_id, reward_side),
    UNIQUE KEY uk_referral_reward_idempotency (idempotency_key),
    KEY idx_referral_reward_claim (status, next_attempt_at, lease_expires_at),
    KEY idx_referral_reward_beneficiary (beneficiary_user_id, status),
    KEY idx_referral_reward_invitee (invitee_user_id),
    KEY idx_referral_reward_pass (qualifying_pass_id)
);
