ALTER TABLE `providers`
  ADD COLUMN `model_discovery_protocol` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'openai_compatible' AFTER `health_check_url`;

UPDATE `providers`
SET `model_discovery_protocol` = CASE
  WHEN `provider_type` = 'anthropic' THEN 'anthropic'
  ELSE 'openai_compatible'
END
WHERE `model_discovery_protocol` = 'openai_compatible';
