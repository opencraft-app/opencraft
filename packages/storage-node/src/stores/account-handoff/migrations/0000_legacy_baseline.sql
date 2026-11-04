CREATE TABLE `account_handoff_checkpoint` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "account_handoff_singleton" CHECK("account_handoff_checkpoint"."singleton"=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `account_request_facts` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`owner` text NOT NULL,
	`route` text NOT NULL,
	`terminal` text,
	`settled` integer NOT NULL,
	`unknown_seq` integer,
	`unknown_json` text,
	CONSTRAINT "account_request_terminal" CHECK("account_request_facts"."terminal" IN ('completed','failed')),
	CONSTRAINT "account_request_settled" CHECK("account_request_facts"."settled" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `account_request_facts_id_unique` ON `account_request_facts` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_request_facts_unknown_seq_unique` ON `account_request_facts` (`unknown_seq`);