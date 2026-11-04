CREATE TABLE `apps` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`active` integer,
	`next` integer NOT NULL,
	`draft` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner`, `id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `releases` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`uri` text NOT NULL,
	`spec` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`, `revision`),
	FOREIGN KEY (`owner`,`id`) REFERENCES `apps`(`owner`,`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
