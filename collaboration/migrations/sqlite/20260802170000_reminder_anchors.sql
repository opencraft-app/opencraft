-- Add optional Tencent IM message and Thread anchors without changing the published baseline.
ALTER TABLE `reminders` ADD COLUMN `anchor_kind` text NULL;
ALTER TABLE `reminders` ADD COLUMN `anchor_channel_id` text NULL;
ALTER TABLE `reminders` ADD COLUMN `anchor_thread_id` text NULL;
ALTER TABLE `reminders` ADD COLUMN `anchor_message_ref_json` text NULL;
