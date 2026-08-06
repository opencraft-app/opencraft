ALTER TABLE `website_operations`
    ADD COLUMN `next_retry_at` DATETIME NULL COMMENT 'next eligible retry for durable delete cleanup' AFTER `lease_expires_at`,
    ADD KEY `idx_status_next_retry_at` (`status`, `next_retry_at`);
