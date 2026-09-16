ALTER TABLE `computers`
  ADD COLUMN `kind` varchar(255) NOT NULL DEFAULT 'legacy_tat',
  ADD COLUMN `provider_instance_id` varchar(128) NULL,
  ADD COLUMN `desired_state` varchar(255) NOT NULL DEFAULT 'active',
  ADD INDEX `computer_server_id_kind_lifecycle_state_id`
    (`server_id`, `kind`, `lifecycle_state`, `id`);

CREATE TABLE `computer_provider_bindings` (
  `id` varchar(64) NOT NULL,
  `binding_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider_kind` varchar(255) NOT NULL,
  `provider_instance_id` varchar(128) NOT NULL,
  `server_id` varchar(64) NOT NULL,
  `computer_id` varchar(64) NOT NULL,
  `state` varchar(255) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`binding_hash`, `id`),
  UNIQUE INDEX `computerproviderbinding_binding_hash` (`binding_hash`),
  INDEX `computerproviderbinding_binding_hash_server_id_computer_id`
    (`binding_hash`, `server_id`, `computer_id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`binding_hash`;
