import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import {
  applySqlMigrations,
  hashSqlMigrations,
  hasMigrationLedger,
  SqlMigrationError,
  validateMigrationHistory,
} from "@opencraft/sql/migrations";
import { modelPolicyMigrations, type ModelPolicyDatabase } from "./store.js";

export interface ModelPolicySqlOwnerOptions {
  /** Names the owner's own storage objects (a runtime's reserved tables) that are not policy schema. */
  readonly ownedByRuntime?: (name: string) => boolean;
}

/**
 * Slim policy lifecycle for an owner whose SQL database is already exclusive
 * and durable (a Durable Object): ledger validation, checksum refusal and the
 * published migrations, each in its own transaction, as
 * `migrateServerSqlDatabase` does for the Server core. No process lock,
 * backup or `:memory:` schema validator; those stay with the Node owner
 * (`openManagedDatabase`). A non-empty database without a ledger is refused
 * rather than adopted. node:crypto is the Node owner's hash source too
 * (workerd provides it under nodejs_compat). The returned handle's `close`
 * releases nothing: the object owns its storage.
 */
export function migrateModelPolicySqlDatabase(
  database: SqlDatabase,
  options: ModelPolicySqlOwnerOptions = {},
): ModelPolicyDatabase {
  const migrations = hashSqlMigrations(modelPolicyMigrations, (text) =>
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
        "Model policy database has objects but no migration ledger; refusing to adopt",
      );
  }
  applySqlMigrations(database, migrations);
  if (validateMigrationHistory(database, migrations) !== migrations.length)
    throw new SqlMigrationError("history-mismatch", "Model policy migration ledger is incomplete after migration");
  const status = before === migrations.length ? "up-to-date" : before > 0 ? "migrated" : "fresh";
  return {
    database,
    outcome: { status, appliedVersion: migrations.length, movedAsidePaths: [] },
    close() {},
  };
}
