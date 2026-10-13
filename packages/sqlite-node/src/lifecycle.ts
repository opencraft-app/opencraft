import { DatabaseSync } from "node:sqlite";
import { openConnection } from "./connection.js";
import { createBackup, moveAside, pruneBackups } from "./backup.js";
import { classifyError, SqliteLifecycleError } from "./errors.js";
import { applyMigrations, hasLedger, LEDGER_SQL, prepareMigrations, recordMigration, schemaFingerprint, transaction, validateHistory, type Migration } from "./migrations.js";

export interface DatabaseOutcome {
  readonly status: "fresh" | "up-to-date" | "migrated" | "adopted" | "moved-aside";
  readonly appliedVersion: number;
  readonly backupPath?: string;
  readonly movedAsidePaths: readonly string[];
}
export interface ManagedDatabaseOptions {
  readonly path: string;
  readonly migrations: readonly Migration[];
  readonly backup?: { readonly keep?: number };
}

export function openManagedDatabase(options: ManagedDatabaseOptions): { database: DatabaseSync; outcome: DatabaseOutcome } {
  let database: DatabaseSync | undefined;
  try {
    const migrations = prepareMigrations(options.migrations);
    const keep = options.backup?.keep ?? 3;
    if (!Number.isSafeInteger(keep) || keep < 1) throw new SqliteLifecycleError("io", "Backup keep must be a positive integer");
    database = openConnection(options.path);
    const applied = validateHistory(database, migrations);
    const fingerprint = schemaFingerprint(database);
    const nonempty = fingerprint !== "[]";
    const legacy = !hasLedger(database) && nonempty;
    let status: DatabaseOutcome["status"] = applied === migrations.length ? "up-to-date" : nonempty || applied > 0 ? "migrated" : "fresh";
    let backupPath: string | undefined;
    let movedAsidePaths: string[] = [];
    if (legacy) {
      const target = openConnection(":memory:");
      let matches: boolean;
      try { applyMigrations(target, migrations); matches = fingerprint === schemaFingerprint(target); }
      finally { target.close(); }
      if (!matches && options.path === ":memory:") throw new SqliteLifecycleError("unsupported-legacy", "Cannot move aside an in-memory legacy database");
      backupPath = createBackup(database, options.path, migrations.length);
      if (matches) {
        const connection = database;
        transaction(connection, () => {
          if (hasLedger(connection) || schemaFingerprint(connection) !== fingerprint) throw new SqliteLifecycleError("history-mismatch", "Legacy schema changed during adoption");
          connection.exec(LEDGER_SQL);
          for (const migration of migrations) recordMigration(connection, migration);
        });
        status = "adopted";
      } else {
        // Close checkpoints this owner's WAL; move any remaining sidecars with the database.
        database.close();
        database = undefined;
        movedAsidePaths = moveAside(options.path);
        database = openConnection(options.path);
        applyMigrations(database, migrations);
        status = "moved-aside";
      }
    } else if (applied < migrations.length) {
      if (nonempty || hasLedger(database)) backupPath = createBackup(database, options.path, migrations.length);
      applyMigrations(database, migrations);
    }
    validateHistory(database, migrations);
    if (backupPath) pruneBackups(options.path, keep, backupPath);
    return { database, outcome: { status, appliedVersion: migrations.length, ...(backupPath ? { backupPath } : {}), movedAsidePaths } };
  } catch (error) {
    database?.close();
    throw classifyError(error);
  }
}
