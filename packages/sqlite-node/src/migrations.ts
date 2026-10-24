import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SqliteLifecycleError } from "./errors.js";

export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export interface HashedMigration extends Migration { readonly checksum: string }
export const LEDGER_SQL = "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";

export function prepareMigrations(migrations: readonly Migration[]): readonly HashedMigration[] {
  if (!migrations.length || migrations.some((migration, index) => migration.version !== index + 1 || !migration.name || !migration.sql)) {
    throw new SqliteLifecycleError("history-mismatch", "Migration versions must start at 1 and be contiguous");
  }
  return migrations.map(migration => ({ ...migration, checksum: createHash("sha256").update(migration.sql).digest("hex") }));
}

export function hasLedger(database: DatabaseSync): boolean {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
}

export function validateHistory(database: DatabaseSync, migrations: readonly HashedMigration[]): number {
  if (!hasLedger(database)) return 0;
  const rows = database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  if (rows.some(row => Number(row.version) > migrations.length)) {
    throw new SqliteLifecycleError("newer-schema", "Unsupported newer database migration history");
  }
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || row.version !== index + 1 || row.checksum !== migration.checksum || row.name !== migration.name) {
      throw new SqliteLifecycleError("history-mismatch", "Unsupported database migration history");
    }
  }
  return rows.length;
}

export function transaction(database: DatabaseSync, action: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    action();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function recordMigration(database: DatabaseSync, migration: HashedMigration): void {
  database.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)")
    .run(migration.version, migration.name, migration.checksum, Date.now());
}

export function applyMigrations(database: DatabaseSync, migrations: readonly HashedMigration[], validateSchema?: (database: DatabaseSync) => void): void {
  for (const migration of migrations) {
    transaction(database, () => {
      const applied = validateHistory(database, migrations);
      if (migration.version <= applied) return;
      database.exec(LEDGER_SQL);
      database.exec(migration.sql);
      if (migration.version === migrations.length) validateSchema?.(database);
      recordMigration(database, migration);
    });
  }
}

/** Deliberately limited legacy comparison: table set, table_info fields and index names. */
export function schemaFingerprint(database: DatabaseSync): string {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name!='schema_migrations' ORDER BY name").all();
  return JSON.stringify(tables.map(row => {
    const table = String(row.name).replaceAll('"', '""');
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map(column => ({
      name: column.name, type: column.type, notnull: column.notnull, dflt_value: column.dflt_value, pk: column.pk,
    }));
    const indexes = database.prepare(`PRAGMA index_list("${table}")`).all().map(index => index.name).sort();
    return { name: row.name, columns, indexes };
  }));
}
