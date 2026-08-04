-- Add optional Tencent IM message and Thread anchors without changing the published baseline.
ALTER TABLE `reminders`
  ADD COLUMN `anchor_kind` varchar(255) NULL AFTER `next_fire_at`,
  ADD COLUMN `anchor_channel_id` varchar(64) NULL AFTER `anchor_kind`,
  ADD COLUMN `anchor_thread_id` varchar(64) NULL AFTER `anchor_channel_id`,
  ADD COLUMN `anchor_message_ref_json` longtext NULL AFTER `anchor_thread_id`;
