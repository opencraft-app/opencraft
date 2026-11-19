CREATE TABLE `actor_channel_attachments` (
	`message_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` blob NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
