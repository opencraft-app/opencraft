CREATE TABLE `join_wecom_group_sync` (
	`source` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `join_wecom_sync_channel` ON `join_wecom_group_sync` (`channel_id`);
