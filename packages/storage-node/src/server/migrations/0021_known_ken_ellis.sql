CREATE TABLE `conversation_creation_receipts` (
	`actor_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`server_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`thread_id` text,
	`rejection_status` integer,
	`rejection_code` text,
	PRIMARY KEY(`actor_id`, `operation_key`),
	CONSTRAINT "creation_receipt_state" CHECK((
    (state = 'claimed' AND thread_id IS NULL) OR
    (state IN ('created', 'submitted', 'first_rejected') AND thread_id IS NOT NULL) OR
    (state = 'rejected' AND thread_id IS NULL)
  ) AND (
    (state = 'rejected' AND rejection_status IS NOT NULL AND rejection_code IS NOT NULL) OR
    (state <> 'rejected' AND rejection_status IS NULL AND rejection_code IS NULL)
  ))
) STRICT;
