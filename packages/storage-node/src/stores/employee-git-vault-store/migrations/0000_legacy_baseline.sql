CREATE TABLE `employee_git_credentials` (
	`account` text NOT NULL,
	`host` text NOT NULL,
	`revision` integer NOT NULL,
	`credential` blob,
	PRIMARY KEY(`account`, `host`),
	CONSTRAINT "employee_git_credentials_check_0" CHECK(revision>0)
) STRICT;
