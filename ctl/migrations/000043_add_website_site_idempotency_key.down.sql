ALTER TABLE `website_sites`
    DROP INDEX `uk_user_idempotency`,
    DROP COLUMN `idempotency_key`;
