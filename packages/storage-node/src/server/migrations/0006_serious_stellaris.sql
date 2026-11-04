CREATE TABLE `conversation_input_settings` (
	`request_id` text PRIMARY KEY NOT NULL,
	`model` text,
	`reasoning_effort` text,
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_input_settings_explicit" CHECK(model IS NOT NULL OR reasoning_effort IS NOT NULL)
) STRICT;
