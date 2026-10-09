-- Tombstone Agent identity without deleting Computer-level TAT state.
ALTER TABLE `agents`
  ADD COLUMN `deleted_at` datetime(3) NULL AFTER `current_launch_updated_at`;
