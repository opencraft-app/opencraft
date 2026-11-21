import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  retireManagedDatabase,
  sqliteTransaction,
  SqliteLifecycleError,
  type BorrowedDatabase,
} from "@opencraft/sqlite-node";
import { openDocumentDatabase } from "@opencraft/document-storage/sqlite";
import { openClientResourcesDatabase } from "@opencraft/document-storage/client-resources-sqlite";
import { DESKTOP_CLIENT_DATABASE, openDesktopClientDatabase } from "./desktop-client-storage.js";
import { openUiPreferencesDatabase } from "./ui-preferences-store.js";
import { openConnectorConfigurationDatabase } from "./connector-configuration-store.js";

interface LegacySource {
  readonly file: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly key: string;
  readonly open: (path: string) => BorrowedDatabase;
}

/** Standalone client files that earlier releases kept beside each other in userData. */
export const LEGACY_DESKTOP_CLIENT_SOURCES: readonly LegacySource[] = [
  {
    file: "opencraft-ui.sqlite",
    table: "ui_preferences",
    columns: ["key", "value_json", "revision", "updated_at"],
    key: "key",
    open: openUiPreferencesDatabase,
  },
  {
    file: "opencraft-connectors.sqlite",
    table: "connector_configuration",
    columns: ["id", "revision", "value"],
    key: "id",
    open: openConnectorConfigurationDatabase,
  },
  {
    file: "opencraft-extensions.sqlite",
    table: "extension_records",
    columns: ["scope", "revision", "data_version", "value_json"],
    key: "scope",
    open: openDocumentDatabase,
  },
  {
    file: "opencraft-client-resources.sqlite",
    table: "client_resources",
    columns: ["identity", "namespace", "authority", "revision", "version", "saved_at", "value_json"],
    key: "identity",
    open: openClientResourcesDatabase,
  },
];

type Row = Record<string, string | number | null>;

function readRows(database: DatabaseSync, source: LegacySource): Row[] {
  return database
    .prepare(`SELECT ${source.columns.join(",")} FROM ${source.table} ORDER BY ${source.key}`)
    .all() as Row[];
}

function rowsDigest(rows: readonly Row[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function receipt(target: DatabaseSync, file: string): { digest: string } | undefined {
  return target.prepare("SELECT digest FROM desktop_client_imports WHERE source=?").get(file) as
    { digest: string } | undefined;
}

/**
 * Copy each standalone legacy file into the desktop client database once.
 *
 * Rows and their receipt commit in one target transaction, so a second
 * instance starting at the same time waits and then sees the receipt. The
 * source then receives a retirement ledger entry: an older release refuses it
 * instead of reading rows that stopped changing here. The source file stays
 * on disk unchanged otherwise, as the recovery copy.
 */
export function importLegacyDesktopClientStorage(
  directory: string,
  target: DatabaseSync,
  now: () => number = Date.now,
): void {
  for (const source of LEGACY_DESKTOP_CLIENT_SOURCES) {
    const path = join(directory, source.file);
    if (!existsSync(path)) continue;
    let legacy: BorrowedDatabase;
    try {
      legacy = source.open(path);
    } catch (error) {
      // Already retired by an earlier import (the marker reads as a newer ledger).
      if (error instanceof SqliteLifecycleError && error.kind === "newer-schema" && receipt(target, source.file))
        continue;
      throw error;
    }
    try {
      sqliteTransaction(target, () => {
        const rows = readRows(legacy.database, source);
        const digest = rowsDigest(rows);
        const existing = receipt(target, source.file);
        if (existing) {
          // A crash between import and retirement: retire only an unchanged source.
          if (existing.digest !== digest) {
            throw new SqliteLifecycleError(
              "history-mismatch",
              `${source.file} changed after it was imported; both files are kept for manual recovery`,
            );
          }
          return;
        }
        const { count } = target.prepare(`SELECT COUNT(*) AS count FROM ${source.table}`).get() as { count: number };
        if (Number(count) !== 0) {
          throw new SqliteLifecycleError(
            "history-mismatch",
            `Desktop client storage already holds ${source.table}; ${source.file} was not merged`,
          );
        }
        const insert = target.prepare(
          `INSERT INTO ${source.table} (${source.columns.join(",")}) VALUES (${source.columns.map(() => "?").join(",")})`,
        );
        for (const row of rows) insert.run(...source.columns.map((column) => row[column] ?? null));
        target
          .prepare("INSERT INTO desktop_client_imports(source,row_count,digest,imported_at) VALUES(?,?,?,?)")
          .run(source.file, rows.length, digest, now());
      });
      retireManagedDatabase(legacy.database, DESKTOP_CLIENT_DATABASE);
    } finally {
      legacy.database.close();
    }
  }
}

/** Open the desktop client database and merge any standalone files left by earlier releases. */
export function openDesktopClientStorage(directory: string): BorrowedDatabase {
  const storage = openDesktopClientDatabase(directory);
  try {
    importLegacyDesktopClientStorage(directory, storage.database);
    return storage;
  } catch (error) {
    storage.database.close();
    throw error;
  }
}
