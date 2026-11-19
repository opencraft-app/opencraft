import type { Migration } from '@opencraft/sqlite-node';
const baseline: readonly Migration[] = [{ version: 1, name: 'browser-resources-metadata-retirements', sql: `
CREATE TABLE browser_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_pages (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_receipts (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_retirements (key TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL) STRICT;
CREATE INDEX browser_retirements_owner ON browser_retirements(owner);
` }];

// Frozen generated migration tail; internal core predates the shared store registry.
export const migrations: readonly Migration[] = [...baseline, ...[{"version": 2, "name": "0001_tearful_wild_child", "sql": "CREATE TABLE `browser_retirement_identities` (\n\t`owner` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`id` text NOT NULL,\n\t`key` text NOT NULL,\n\tPRIMARY KEY(`owner`, `kind`, `id`, `key`)\n) STRICT;\n\n--> statement-breakpoint\nINSERT INTO browser_retirement_identities SELECT r.owner,'page',j.value,r.key FROM browser_retirements r,json_each(r.value,'$.pageIds') j GROUP BY r.owner,j.value,r.key;\nINSERT INTO browser_retirement_identities SELECT r.owner,'tab',j.value,r.key FROM browser_retirements r,json_each(r.value,'$.tabIds') j GROUP BY r.owner,j.value,r.key;\nINSERT INTO browser_retirement_identities SELECT owner,'lease',json_extract(value,'$.lease'),key FROM browser_retirements;\n"}, {"version": 3, "name": "0002_busy_nightmare", "sql": "CREATE TABLE `browser_presentations` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`owner` text NOT NULL,\n\t`value` text NOT NULL\n) STRICT;\n"}, {"version": 4, "name": "0003_jazzy_baron_zemo", "sql": "CREATE TABLE `browser_operations` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`owner` text NOT NULL,\n\t`value` text NOT NULL\n) STRICT;\n"}]];
