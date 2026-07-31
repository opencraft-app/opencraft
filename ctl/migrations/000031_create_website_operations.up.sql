CREATE TABLE IF NOT EXISTS `website_operations` (
    `id`             BIGINT       NOT NULL AUTO_INCREMENT,
    `operation_id`   VARCHAR(64)  NOT NULL COMMENT '业务操作ID wo-xxxxxxxx',
    `site_id`        VARCHAR(64)  NOT NULL,
    `release_id`     VARCHAR(64)  NOT NULL DEFAULT '',
    `user_id`        VARCHAR(64)  NOT NULL,
    `operation_type` VARCHAR(32)  NOT NULL COMMENT 'create/deploy/delete',
    `status`         VARCHAR(32)  NOT NULL DEFAULT 'created' COMMENT 'created/running/success/failed',
    `error_message`  VARCHAR(2048) NOT NULL DEFAULT '',
    `created_time`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_operation_id` (`operation_id`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
