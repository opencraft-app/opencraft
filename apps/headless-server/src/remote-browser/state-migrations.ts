import type { Migration } from '@opencraft/sqlite-node';
export const migrations: readonly Migration[] = [{ version: 1, name: 'browser-resources-metadata-retirements', sql: `
CREATE TABLE browser_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_pages (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_receipts (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE browser_retirements (key TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL) STRICT;
CREATE INDEX browser_retirements_owner ON browser_retirements(owner);
` }];
