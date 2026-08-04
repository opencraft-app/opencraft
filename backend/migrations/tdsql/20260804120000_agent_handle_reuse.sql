-- Keep the historical handle on tombstoned members while reserving it only for active members.
ALTER TABLE `members`
  ADD COLUMN `active_handle_key` varchar(255) NULL AFTER `handle`;
UPDATE `members`
  SET `active_handle_key` = `handle`
  WHERE `status` = 'active';
DROP INDEX `member_server_id_handle` ON `members`;
CREATE UNIQUE INDEX `member_server_id_active_handle_key`
  ON `members` (`server_id`, `active_handle_key`);
