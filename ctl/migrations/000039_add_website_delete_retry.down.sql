ALTER TABLE `website_operations`
    DROP INDEX `idx_status_next_retry_at`,
    DROP COLUMN `next_retry_at`;
