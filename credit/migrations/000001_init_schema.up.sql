CREATE TABLE IF NOT EXISTS credit_product (
    id                  BIGINT       PRIMARY KEY AUTO_INCREMENT,
    product_id          VARCHAR(64)  NOT NULL UNIQUE,
    product_name        VARCHAR(128) NOT NULL,
    llm_gateway_plan_id VARCHAR(128) NOT NULL,
    state               VARCHAR(32)  NOT NULL,
    created_time        DATETIME     NOT NULL,
    updated_time        DATETIME     NOT NULL,
    KEY idx_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='credit 积分包售卖商品表';

CREATE TABLE IF NOT EXISTS credit_package (
    id                    BIGINT       PRIMARY KEY AUTO_INCREMENT,
    package_id            VARCHAR(64)  NOT NULL UNIQUE,
    user_id               VARCHAR(128) NOT NULL,
    product_id            VARCHAR(64)  NOT NULL,
    uin                   VARCHAR(64)  NOT NULL,
    app_id                BIGINT       NOT NULL,
    deal_name             VARCHAR(128) NOT NULL UNIQUE,
    big_order_id          VARCHAR(128) NOT NULL,
    llm_gateway_plan_id   VARCHAR(128) NOT NULL,
    llm_subscription_id   VARCHAR(128) NOT NULL,
    llm_subscription_name VARCHAR(192) NOT NULL,
    created_time          DATETIME     NOT NULL,
    expired_time          DATETIME     NOT NULL,
    isolated_time         DATETIME     DEFAULT NULL,
    status                VARCHAR(32)  NOT NULL,
    updated_time          DATETIME     NOT NULL,
    KEY idx_user_status (user_id, status),
    KEY idx_uin_appid (uin, app_id),
    KEY idx_expired_time (expired_time),
    KEY idx_llm_subscription_name (llm_subscription_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='credit 付费积分包实例表';

CREATE TABLE IF NOT EXISTS history_credit_package (
    id                    BIGINT       PRIMARY KEY AUTO_INCREMENT,
    package_id            VARCHAR(64)  NOT NULL UNIQUE,
    user_id               VARCHAR(128) NOT NULL,
    product_id            VARCHAR(64)  NOT NULL,
    uin                   VARCHAR(64)  NOT NULL,
    app_id                BIGINT       NOT NULL,
    deal_name             VARCHAR(128) NOT NULL,
    big_order_id          VARCHAR(128) NOT NULL,
    llm_gateway_plan_id   VARCHAR(128) NOT NULL,
    llm_subscription_id   VARCHAR(128) NOT NULL,
    llm_subscription_name VARCHAR(192) NOT NULL,
    created_time          DATETIME     NOT NULL,
    expired_time          DATETIME     NOT NULL,
    isolated_time         DATETIME     DEFAULT NULL,
    deleted_time          DATETIME     NOT NULL,
    destroy_reason        VARCHAR(64)  NOT NULL,
    status                VARCHAR(32)  NOT NULL,
    KEY idx_user_deleted (user_id, deleted_time),
    KEY idx_deal_name (deal_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='credit 付费积分包销毁历史表';
