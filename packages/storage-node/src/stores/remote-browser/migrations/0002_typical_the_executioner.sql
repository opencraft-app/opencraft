CREATE TABLE `browser_operations` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_presentations` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`value` text NOT NULL
);
