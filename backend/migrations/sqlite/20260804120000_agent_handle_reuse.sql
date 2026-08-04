-- Keep the historical handle on tombstoned members while reserving it only for active members.
PRAGMA foreign_keys = off;
CREATE TABLE `new_members` (
  `id` text NOT NULL,
  `server_id` text NOT NULL,
  `account_id` text NULL,
  `kind` text NOT NULL,
  `role` text NOT NULL,
  `display_name` text NOT NULL,
  `handle` text NOT NULL,
  `active_handle_key` text NULL,
  `status` text NOT NULL,
  `im_state` text NOT NULL,
  `revision` integer NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
);
INSERT INTO `new_members` (
  `id`, `server_id`, `account_id`, `kind`, `role`, `display_name`,
  `handle`, `active_handle_key`, `status`, `im_state`, `revision`,
  `created_at`, `updated_at`
)
SELECT
  `id`, `server_id`, `account_id`, `kind`, `role`, `display_name`,
  `handle`, CASE WHEN `status` = 'active' THEN `handle` ELSE NULL END,
  `status`, `im_state`, `revision`, `created_at`, `updated_at`
FROM `members`;
DROP TABLE `members`;
ALTER TABLE `new_members` RENAME TO `members`;
CREATE UNIQUE INDEX `member_server_id_active_handle_key`
  ON `members` (`server_id`, `active_handle_key`);
CREATE UNIQUE INDEX `member_server_id_account_id`
  ON `members` (`server_id`, `account_id`);
CREATE INDEX `member_server_id_status_id`
  ON `members` (`server_id`, `status`, `id`);
PRAGMA foreign_keys = on;
