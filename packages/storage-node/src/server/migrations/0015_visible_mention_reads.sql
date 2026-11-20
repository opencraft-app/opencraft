CREATE TABLE `actor_channel_mention_reads` (
	`message_id` text NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `actor_id`),
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
-- Preserve the previously published read state without resurrecting historical alerts.
INSERT OR IGNORE INTO actor_channel_mention_reads(message_id,actor_id)
SELECT DISTINCT n.message_id,n.actor_id FROM actor_channel_mentions n
JOIN actor_messages m ON m.id=n.message_id
JOIN actor_channel_members cm ON cm.channel_id=m.channel_id AND cm.actor_id=n.actor_id
JOIN actor_channel_reads r ON r.channel_id=cm.channel_id AND r.actor_id=cm.actor_id AND r.epoch=cm.epoch
WHERE m.seq<=r.read_seq;
