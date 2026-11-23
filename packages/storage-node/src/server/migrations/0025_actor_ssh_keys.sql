CREATE TABLE `actor_ssh_key_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL,
	`actor_id` text,
	`key_id` text,
	`fingerprint` text,
	`action` text NOT NULL,
	`result` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_ssh_key_audit_actor` ON `actor_ssh_key_audit` (`actor_id`,`id`);--> statement-breakpoint
CREATE TABLE `actor_ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_generation` integer NOT NULL,
	`name` text NOT NULL,
	`algorithm` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoked_reason` text,
	CONSTRAINT "actor_ssh_key_row" CHECK(length(id) BETWEEN 1 AND 128
    AND length(actor_id) BETWEEN 1 AND 512
    AND length(name) BETWEEN 1 AND 128
    AND length(public_key) BETWEEN 1 AND 16384
    AND fingerprint LIKE 'SHA256:%'
    AND (revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_ssh_keys_actor` ON `actor_ssh_keys` (`actor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `actor_ssh_keys_active_fingerprint` ON `actor_ssh_keys` (`fingerprint`) WHERE "actor_ssh_keys"."revoked_at" IS NULL;