ALTER TABLE `website_operations`
    DROP INDEX `idx_status_lease_expires_at`,
    DROP COLUMN `site_generation`,
    DROP COLUMN `attempt`,
    DROP COLUMN `lease_expires_at`,
    DROP COLUMN `lease_token`;
