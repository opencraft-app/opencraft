import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isThenable, SqlAsyncTransactionError } from "@opencraft/sql";
import {
  applySqlMigrations, hashSqlMigrations, hasMigrationLedger, MIGRATION_LEDGER_SQL, recordSqlMigration, validateMigrationHistory,
  type HashedSqlMigration, type SqlMigration, type SqlMigrationErrorKind,
} from "@opencraft/sql/migrations";
import { SqliteLifecycleError } from "./errors.js";
// sql-database.ts imports transaction() from here; both sides only call each other at run time.
import { nodeSqlDatabase, type NodeSqliteConnection } from "./sql-database.js";

// The ledger rules are runtime-neutral (@opencraft/sql/migrations); this Node
// owner keeps its error type and adds backup, locks, legacy adoption and the
// :memory: schema validator around them (lifecycle.ts).
export type Migration = SqlMigration;
export type HashedMigration = HashedSqlMigration;
export const LEDGER_SQL = MIGRATION_LEDGER_SQL;
const ledger = { fail: (kind: SqlMigrationErrorKind, message: string) => new SqliteLifecycleError(kind, message) };
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

let savepointSequence = 0;
/**
 * The only Node implementation of the SQL port's transaction semantics: a write
 * transaction at the outermost call, savepoints when nested, synchronous actions.
 */
export function transaction<T>(database: NodeSqliteConnection, action: () => T): T {
  const savepoint = database.isTransaction ? `opencraft_${++savepointSequence}` : null;
  database.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = action();
    if (isThenable(result)) throw new SqlAsyncTransactionError();
    database.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      if (savepoint) database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      else database.exec("ROLLBACK");
    }
    throw error;
  }
}

export function prepareMigrations(migrations: readonly Migration[]): readonly HashedMigration[] {
  return hashSqlMigrations(migrations, sha256Hex, ledger);
}

export function hasLedger(database: DatabaseSync): boolean {
  return hasMigrationLedger(nodeSqlDatabase(database));
}

export function validateHistory(database: DatabaseSync, migrations: readonly HashedMigration[]): number {
  return validateMigrationHistory(nodeSqlDatabase(database), migrations, ledger);
}

export function recordMigration(database: DatabaseSync, migration: HashedMigration): void {
  recordSqlMigration(nodeSqlDatabase(database), migration);
}

export function applyMigrations(database: DatabaseSync, migrations: readonly HashedMigration[], validateSchema?: (database: DatabaseSync) => void): void {
  applySqlMigrations(nodeSqlDatabase(database), migrations, { ...ledger, ...(validateSchema ? { validateSchema: () => validateSchema(database) } : {}) });
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
