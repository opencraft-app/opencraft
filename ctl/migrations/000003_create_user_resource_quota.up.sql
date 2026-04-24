CREATE TABLE IF NOT EXISTS `user_resource_quota` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` VARCHAR(255) NOT NULL,
    `resource_name` VARCHAR(255) NOT NULL,
    `resource_key` VARCHAR(255) NOT NULL DEFAULT '',
    `resource_quota_available` BIGINT NOT NULL,
    `resource_quota_total` BIGINT NOT NULL,
    `created_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_resource_key` (`user_id`, `resource_name`, `resource_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
