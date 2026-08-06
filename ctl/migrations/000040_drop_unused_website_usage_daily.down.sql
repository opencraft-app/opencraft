CREATE TABLE IF NOT EXISTS `website_usage_daily` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `site_id`       VARCHAR(64)  NOT NULL,
    `user_id`       VARCHAR(64)  NOT NULL,
    `usage_date`    DATE         NOT NULL,
    `traffic_bytes` BIGINT       NOT NULL DEFAULT 0,
    `request_count` BIGINT       NOT NULL DEFAULT 0,
    `created_time`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_date` (`site_id`, `usage_date`),
    KEY `idx_user_date` (`user_id`, `usage_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
