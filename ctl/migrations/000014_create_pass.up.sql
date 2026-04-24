CREATE TABLE IF NOT EXISTS `pass` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `pass_id`         VARCHAR(64)  NOT NULL,
    `user_id`         VARCHAR(64)  NOT NULL,
    `bundle_id`       VARCHAR(64)  NOT NULL,
    `uin`             BIGINT       NOT NULL COMMENT '腾讯云用户账号（冗余自 shadow Binding）',
    `app_id`          BIGINT       NOT NULL COMMENT '腾讯云应用 ID（冗余自 shadow Binding）',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `expired_time`    DATETIME     NOT NULL,
    `isolated_time`   DATETIME     NULL     COMMENT '预留：隔离时间',
    `deleted_time`    DATETIME     NULL     COMMENT '预留：销毁时间',
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_pass_id` (`pass_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_bundle_id` (`bundle_id`),
    KEY `idx_app_id` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
