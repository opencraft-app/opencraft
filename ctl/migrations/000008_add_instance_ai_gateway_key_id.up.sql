ALTER TABLE `instances`
    ADD COLUMN `ai_gateway_key_id` VARCHAR(64) NULL AFTER `sandbox_id`,
    ADD KEY `idx_ai_gateway_key_id` (`ai_gateway_key_id`);
