CREATE TABLE IF NOT EXISTS payment_orders (
    id                 CHAR(36) PRIMARY KEY,
    external_user_id   VARCHAR(64) NOT NULL,
    code               VARCHAR(32) NOT NULL,
    status             VARCHAR(32) NOT NULL,
    provider           VARCHAR(32) NOT NULL,
    provider_order_id  VARCHAR(128) NULL,
    checkout_url       TEXT NULL,
    created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_payment_orders_external_user_id (external_user_id),
    KEY idx_payment_orders_status (status)
);

CREATE TABLE IF NOT EXISTS payment_events (
    id                CHAR(36) PRIMARY KEY,
    payment_order_id  CHAR(36) NOT NULL,
    event_type        VARCHAR(32) NOT NULL,
    provider_order_id VARCHAR(128) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_payment_events_order_id (payment_order_id),
    KEY idx_payment_events_created_at (created_at)
);
