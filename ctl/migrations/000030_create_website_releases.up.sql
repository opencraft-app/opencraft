CREATE TABLE IF NOT EXISTS `website_releases` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT,
    `release_id`    VARCHAR(64)  NOT NULL COMMENT '业务发布ID wr-xxxxxxxx',
    `site_id`       VARCHAR(64)  NOT NULL,
    `user_id`       VARCHAR(64)  NOT NULL,
    `version`       INT          NOT NULL DEFAULT 1 COMMENT '递增版本号',
    `status`        VARCHAR(32)  NOT NULL DEFAULT 'pending' COMMENT 'pending/uploading/deploying/active/failed/rolled_back',
    `artifact_hash` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '制品SHA-256',
    `artifact_size` BIGINT       NOT NULL DEFAULT 0 COMMENT '制品大小(字节)',
    `file_count`    INT          NOT NULL DEFAULT 0,
    `error_message` VARCHAR(1024) NOT NULL DEFAULT '',
    `created_time`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_release_id` (`release_id`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
