ALTER TABLE `computers`
  MODIFY COLUMN `kind` varchar(255) NOT NULL DEFAULT 'legacy_tat' AFTER `name`,
  MODIFY COLUMN `provider_instance_id` varchar(128) NULL AFTER `kind`,
  MODIFY COLUMN `desired_state` varchar(255) NOT NULL DEFAULT 'active' AFTER `provider_instance_id`;;
