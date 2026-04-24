CREATE TABLE IF NOT EXISTS `bundle` (
    `id`                           BIGINT       NOT NULL AUTO_INCREMENT,
    `bundle_id`                    VARCHAR(64)  NOT NULL,
    `bundle_name`                  VARCHAR(128) NOT NULL DEFAULT '',
    `description`                  TEXT         NOT NULL,
    `bundle_state`                 VARCHAR(32)  NOT NULL DEFAULT 'OFFLINE',
    `agent_quota`                  BIGINT       NOT NULL DEFAULT 0,
    `ai_gateway_plan_id`           VARCHAR(64)  NOT NULL DEFAULT '',
    `monthly_tokens`               BIGINT       NOT NULL DEFAULT 0,
    `static_sold_out`              TINYINT(1)   NOT NULL DEFAULT 0,
    `bundle_sales_available_count` INT          NOT NULL DEFAULT 0,
    `bundle_sales_total_count`     INT          NOT NULL DEFAULT 0,
    `created_time`                 DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`                 DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_bundle_id` (`bundle_id`),
    KEY `idx_bundle_state` (`bundle_state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
