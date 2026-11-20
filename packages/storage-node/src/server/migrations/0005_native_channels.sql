CREATE TABLE `actor_channel_changes` (
	`revision` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channel_changes_message_id_unique` ON `actor_channel_changes` (`message_id`);--> statement-breakpoint
CREATE INDEX `actor_channel_changes_by_channel` ON `actor_channel_changes` (`channel_id`,`revision`);--> statement-breakpoint
CREATE TABLE `actor_channel_execution_membership` (
	`request_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`requester_epoch` text NOT NULL,
	`target_epoch` text NOT NULL,
	PRIMARY KEY(`request_id`, `channel_id`),
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_identity` (
	`epoch` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_channel_members` (
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`epoch` text NOT NULL,
	PRIMARY KEY(`channel_id`, `actor_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_channel_members_actor` ON `actor_channel_members` (`actor_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `actor_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`peer_id` text,
	`title` text,
	`create_key` text,
	`create_fingerprint` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_channels_owner_id_create_key_unique` ON `actor_channels` (`owner_id`,`create_key`);--> statement-breakpoint
CREATE INDEX `actor_channels_peer` ON `actor_channels` (`peer_id`);--> statement-breakpoint
ALTER TABLE `actor_messages` ADD `author_display_name` text;
--> statement-breakpoint
INSERT INTO actor_channel_identity VALUES(lower(hex(randomblob(16))));
--> statement-breakpoint
INSERT INTO actor_channels(id,owner_id,peer_id)
  SELECT DISTINCT channel_id,min(author_id,target_id),max(author_id,target_id)
  FROM actor_messages WHERE target_kind='actor';
--> statement-breakpoint
INSERT INTO actor_channel_changes(channel_id,message_id)
  SELECT channel_id,id FROM actor_messages WHERE target_kind='actor' ORDER BY seq;
CREATE TRIGGER actor_channel_message_inserted AFTER INSERT ON actor_messages
  WHEN new.target_kind IN ('actor','channel') BEGIN
    INSERT INTO actor_channel_changes(channel_id,message_id) VALUES(new.channel_id,new.id);
END;
CREATE TRIGGER actor_channel_request_linked AFTER INSERT ON actor_execution_inputs BEGIN
    INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id)
      SELECT channel_id,id FROM actor_messages WHERE id=new.message_id AND target_kind IN ('actor','channel');
END;
