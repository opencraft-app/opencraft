CREATE TABLE IF NOT EXISTS `instances` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `instance_id` VARCHAR(255) NOT NULL,
    `user_id` VARCHAR(255) NOT NULL,
    `sandbox_id` VARCHAR(255) NOT NULL,
    `sandbox_id_key` VARCHAR(255) GENERATED ALWAYS AS (NULLIF(`sandbox_id`, '')) STORED,
    `status` VARCHAR(50) NOT NULL,
    `timeout_at` DATETIME NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_at` DATETIME NULL DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_instance_id` (`instance_id`),
    UNIQUE KEY `uk_sandbox_id` (`sandbox_id_key`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
