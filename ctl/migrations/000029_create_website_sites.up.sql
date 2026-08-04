CREATE TABLE IF NOT EXISTS `website_sites` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `site_id`      VARCHAR(64)  NOT NULL COMMENT '业务站点ID ws-xxxxxxxx',
    `user_id`      VARCHAR(64)  NOT NULL,
    `pass_id`      VARCHAR(64)  NOT NULL COMMENT '创建时关联的Pass',
    `bundle_id`    VARCHAR(64)  NOT NULL COMMENT '创建时关联的套餐',
    `name`         VARCHAR(128) NOT NULL DEFAULT '' COMMENT '站点名称',
    `status`       VARCHAR(32)  NOT NULL DEFAULT 'creating' COMMENT 'creating/active/suspended/deleted',
    `cloud_path`   VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'CloudBase中的路径',
    `public_url`   VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'Vela分配的公开URL',
    `created_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_time` DATETIME     NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
