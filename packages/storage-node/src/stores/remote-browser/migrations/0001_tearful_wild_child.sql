CREATE TABLE `browser_retirement_identities` (
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`key` text NOT NULL,
	PRIMARY KEY(`owner`, `kind`, `id`, `key`)
);

--> statement-breakpoint
INSERT INTO browser_retirement_identities SELECT r.owner,'page',j.value,r.key FROM browser_retirements r,json_each(r.value,'$.pageIds') j GROUP BY r.owner,j.value,r.key;
INSERT INTO browser_retirement_identities SELECT r.owner,'tab',j.value,r.key FROM browser_retirements r,json_each(r.value,'$.tabIds') j GROUP BY r.owner,j.value,r.key;
INSERT INTO browser_retirement_identities SELECT owner,'lease',json_extract(value,'$.lease'),key FROM browser_retirements;
