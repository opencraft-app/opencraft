CREATE TABLE `browser_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_pages` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_retirements` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_retirements_owner` ON `browser_retirements` (`owner`);