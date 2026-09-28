CREATE TABLE referral_attribution_reset_audit (
    operation_id VARCHAR(64) PRIMARY KEY,
    idempotency_key VARCHAR(191) NOT NULL,
    attribution_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(64) NOT NULL,
    invitee_user_id VARCHAR(64) NOT NULL,
    inviter_user_id VARCHAR(64) NOT NULL,
    referral_code VARCHAR(32) NOT NULL,
    operator_id VARCHAR(128) NOT NULL,
    reason VARCHAR(512) NOT NULL,
    reward_count INT NOT NULL,
    revoked_subscription_count INT NOT NULL,
    snapshot_json JSON NOT NULL,
    created_at DATETIME(6) NOT NULL,
    completed_at DATETIME(6) NOT NULL,
    UNIQUE KEY uk_referral_reset_idempotency (idempotency_key),
    KEY idx_referral_reset_invitee (invitee_user_id, completed_at),
    KEY idx_referral_reset_attribution (attribution_id)
);
