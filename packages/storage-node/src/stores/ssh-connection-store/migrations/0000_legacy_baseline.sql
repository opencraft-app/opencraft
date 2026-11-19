CREATE TABLE `ssh_connections` (
	`server_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`config_json` text NOT NULL,
	`host_key` text NOT NULL,
	`credential` blob NOT NULL
) STRICT;
