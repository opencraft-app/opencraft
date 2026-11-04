CREATE TABLE `conversation_input_execution_options` (
	`request_id` text PRIMARY KEY NOT NULL,
	`service_tier_for_turn` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
