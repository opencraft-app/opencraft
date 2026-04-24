ALTER TABLE `instances`
    ADD COLUMN `gateway_auth_token` VARCHAR(128) NULL AFTER `ai_gateway_key_id`,
    ADD KEY `idx_gateway_auth_token` (`gateway_auth_token`);
