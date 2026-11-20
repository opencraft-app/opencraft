CREATE TABLE `dsh_consumer_receipt_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dsh_consumer_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
