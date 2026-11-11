import type { Migration } from '@opencraft/sqlite-node';
/** Append only. V1 owns admissions/routes; V2 adds durable delivery and assembly. */
export const migrations: readonly Migration[] = [
  { version: 1, name: 'bridge-command-custody', sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO meta VALUES ('epoch','0'),('current',''),('ack','0');
CREATE TABLE generations (id TEXT PRIMARY KEY, config TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE routes (route TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES generations(id)) STRICT;
CREATE TABLE commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, epoch INTEGER NOT NULL, route TEXT NOT NULL, generation TEXT NOT NULL, method TEXT NOT NULL, state TEXT NOT NULL, response TEXT) STRICT;
` },
  { version: 2, name: 'bridge-outbox-checkpoints', sql: `
CREATE TABLE native_sessions (route TEXT PRIMARY KEY, generation TEXT NOT NULL, native_id TEXT NOT NULL, restorable INTEGER NOT NULL) STRICT;
CREATE TABLE released_routes (route TEXT PRIMARY KEY, generation TEXT NOT NULL) STRICT;
CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE checkpoints (route TEXT PRIMARY KEY, state TEXT NOT NULL, at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE callbacks (generation TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(generation,id)) STRICT;
CREATE TABLE interactions (route TEXT NOT NULL, id TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(route,id)) STRICT;
CREATE TABLE inbox (seq INTEGER PRIMARY KEY, route TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL, projection TEXT NOT NULL) STRICT;
` },
  { version: 3, name: 'automation-script-custody', sql: `
CREATE TABLE automation_scripts (key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT) STRICT;
` },
];
