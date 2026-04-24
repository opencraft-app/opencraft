ALTER TABLE `instances`
    DROP INDEX `idx_gateway_auth_token`,
    DROP COLUMN `gateway_auth_token`;
