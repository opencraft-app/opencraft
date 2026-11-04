CREATE TABLE `im_post_receipts` (
	`scope` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`post_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `request_id`),
	CONSTRAINT "im_post_receipts_check_0" CHECK(state IN ('sending','delivered','rejected','unknown'))
) STRICT;
