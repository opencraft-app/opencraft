import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import {
  applySqlMigrations,
  hashSqlMigrations,
  hasMigrationLedger,
  SqlMigrationError,
  validateMigrationHistory,
} from "@opencraft/sql/migrations";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import {
  serverMigrationComposition,
  type ServerDataContract,
  type ServerMigrationComposition,
} from "./migration-composition.js";
import type { ServerDatabaseHandle } from "./repository-handle.js";

export interface ServerSqlOwnerOptions {
  /** Trusted installation composition; defaults to this build's installed composition. */
  readonly composition?: ServerMigrationComposition;
  /** Names an owner's own storage objects (e.g. a runtime's reserved tables) that are not Server schema. */
  readonly ownedByRuntime?: (name: string) => boolean;
}

/**
 * Slim Server lifecycle for an owner whose SQL database is already exclusive
 * and durable (a Durable Object): ledger validation, checksum refusal and the
 * canonical migrations, each in its own transaction. No process lock, backup,
 * legacy six-store import, alternate-lineage adoption or :memory: schema
 * validator; those stay with openServerDatabase (Node). A non-empty database
 * without a ledger is refused rather than adopted. Runs where the opener runs:
 * node:crypto is the same hash source as Node's prepareMigrations (workerd
 * provides it under nodejs_compat).
 */
export function migrateServerSqlDatabase(
  database: SqlDatabase,
  options: ServerSqlOwnerOptions = {},
): ServerDatabaseHandle & { readonly contract: ServerDataContract } {
  const composition = options.composition ?? serverMigrationComposition();
  const migrations = hashSqlMigrations(composition.canonical, (text) =>
    createHash("sha256").update(text).digest("hex"),
  );
  const before = validateMigrationHistory(database, migrations);
  if (!before && !hasMigrationLedger(database)) {
    const objects = database
      .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .all()
      .filter((row) => !options.ownedByRuntime?.(String(row.name)));
    if (objects.length)
      throw new SqlMigrationError(
        "history-mismatch",
        "Server database has objects but no migration ledger; refusing to adopt",
      );
  }
  applySqlMigrations(database, migrations);
  if (validateMigrationHistory(database, migrations) !== migrations.length) {
    throw new SqlMigrationError("history-mismatch", "Server migration ledger is incomplete after migration");
  }
  const status: DatabaseOutcome["status"] =
    before === migrations.length ? "up-to-date" : before > 0 ? "migrated" : "fresh";
  return {
    database,
    outcome: { status, appliedVersion: migrations.length, movedAsidePaths: [] },
    contract: composition.contract,
  };
}
