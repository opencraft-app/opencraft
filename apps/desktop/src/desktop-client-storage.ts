import { join } from "node:path";
import { openManagedDatabase, type BorrowedDatabase } from "@opencraft/sqlite-node";

/** Electron Main's one client-role database. Server-role data belongs to the daemon. */
export const DESKTOP_CLIENT_DATABASE = "opencraft-desktop.sqlite";

// The four tables keep the definitions of the standalone files they replace,
// so imported rows keep their exact constraints.
const DESKTOP_CLIENT_SCHEMA = `
CREATE TABLE ui_preferences (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE connector_configuration (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL) STRICT;
CREATE TABLE extension_records (scope TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data_version INTEGER NOT NULL, value_json TEXT NOT NULL) STRICT;
CREATE TABLE client_resources (
  identity TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, authority TEXT NOT NULL,
  revision INTEGER NOT NULL, version INTEGER NOT NULL, saved_at INTEGER NOT NULL, value_json TEXT NOT NULL
) STRICT;
CREATE INDEX client_resources_remote ON client_resources(authority, saved_at);
CREATE TABLE desktop_client_imports (
  source TEXT PRIMARY KEY NOT NULL, row_count INTEGER NOT NULL, digest TEXT NOT NULL, imported_at INTEGER NOT NULL
) STRICT`.trim();

export const DESKTOP_CLIENT_MIGRATIONS = [{ version: 1, name: "desktop-client", sql: DESKTOP_CLIENT_SCHEMA }];

export function openDesktopClientDatabase(directory: string): BorrowedDatabase {
  return openManagedDatabase({
    schemaId: "desktop-client",
    path: join(directory, DESKTOP_CLIENT_DATABASE),
    migrations: DESKTOP_CLIENT_MIGRATIONS,
    legacyPolicy: "reject",
  });
}
