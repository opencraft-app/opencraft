CREATE TABLE IF NOT EXISTS subscriptions (
    id                          CHAR(36) PRIMARY KEY,
    external_user_id            VARCHAR(64) NOT NULL,
    code                        VARCHAR(32) NOT NULL,
    status                      VARCHAR(32) NOT NULL,
    ai_gateway_plan_id          CHAR(36) NULL,
    ai_gateway_subscription_id  CHAR(36) NULL,
    current_period_start        DATETIME NULL,
    current_period_end          DATETIME NULL,
    source_order_id             CHAR(36) NULL,
    created_at                  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at                  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_subscriptions_external_user_id (external_user_id),
    KEY idx_subscriptions_status (status)
);

CREATE TABLE IF NOT EXISTS subscription_events (
    id              CHAR(36) PRIMARY KEY,
    subscription_id CHAR(36) NOT NULL,
    event_type      VARCHAR(32) NOT NULL,
    code            VARCHAR(32) NOT NULL,
    status          VARCHAR(32) NOT NULL,
    source_order_id CHAR(36) NULL,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_subscription_events_subscription_id (subscription_id),
    KEY idx_subscription_events_created_at (created_at)
);
