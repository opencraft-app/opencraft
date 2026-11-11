CREATE TABLE `extension_records` (
	`scope` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`data_version` integer NOT NULL,
	`value_json` text NOT NULL
) STRICT;
