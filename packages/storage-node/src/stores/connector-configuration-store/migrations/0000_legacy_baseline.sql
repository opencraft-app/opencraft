CREATE TABLE `connector_configuration` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "connector_configuration_check_0" CHECK(id=1)
) STRICT;
