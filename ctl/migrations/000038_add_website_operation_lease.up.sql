ALTER TABLE `website_operations`
    ADD COLUMN `lease_token` VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'worker ownership token',
    ADD COLUMN `lease_expires_at` DATETIME NULL COMMENT 'worker ownership expiration',
    ADD COLUMN `attempt` INT NOT NULL DEFAULT 0 COMMENT 'number of successful claims',
    ADD COLUMN `site_generation` BIGINT NOT NULL DEFAULT 1 COMMENT 'site generation captured when operation was created',
    ADD KEY `idx_status_lease_expires_at` (`status`, `lease_expires_at`);
