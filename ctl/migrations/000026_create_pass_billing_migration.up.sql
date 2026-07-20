CREATE TABLE IF NOT EXISTS pass_billing_migration (
    id BIGINT NOT NULL AUTO_INCREMENT,
    created_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    pass_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    source_bundle_id VARCHAR(64) NOT NULL,
    target_bundle_id VARCHAR(64) NOT NULL,
    uin BIGINT NOT NULL DEFAULT 0,
    app_id BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    deal_name VARCHAR(64) NULL,
    big_order_id VARCHAR(64) NULL,
    last_error VARCHAR(1024) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_pass_target (pass_id, target_bundle_id),
    KEY idx_user_status (user_id, status),
    KEY idx_status_updated (status, updated_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='存量免费 pass 接入计费迁移状态表';
