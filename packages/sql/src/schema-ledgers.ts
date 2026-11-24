import type { SqlDatabase } from "./contract.js";
import {
  applySqlMigrations,
  assertContiguousMigrations,
  SqlMigrationError,
  validateMigrationHistory,
  type ApplySqlMigrationsOptions,
  type HashedSqlMigration,
  type SqlMigrationLedger,
} from "./migrations.js";

/**
 * Several published migration chains in one database (storage-ports §3.1
 * "同库多条迁移链"). A runtime that gives an owner exactly one database (a
 * Durable Object) hosts every chain the owner composes in it: the database's
 * own chain keeps `schema_migrations`; every further chain keeps its rows in
 * `schema_ledgers` under its schema id, with the same version, name and
 * checksum rules (`./migrations`). Chains never share or rename history: a
 * chain's published SQL, names and checksums are exactly those its other
 * owners apply. A database with a single chain never creates this table, so
 * Node owners (one chain per file) are unaffected.
 */
export const SCHEMA_LEDGER_TABLE = "schema_ledgers";
export const SCHEMA_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_ledgers (schema_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (schema_id, version)) STRICT";
const SCHEMA_ID = /^[a-z][a-z0-9-]{0,63}$/u;

/** The ledger of the chain named `schemaId` in a shared database. */
export function schemaMigrationLedger(schemaId: string): SqlMigrationLedger {
  if (!SCHEMA_ID.test(schemaId))
    throw new SqlMigrationError("history-mismatch", "Schema id must be lowercase letters, digits and dashes");
  return {
    createSql: SCHEMA_LEDGER_SQL,
    exists: (database) =>
      !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_ledgers'").get() &&
      !!database.prepare("SELECT 1 FROM schema_ledgers WHERE schema_id=? LIMIT 1").get(schemaId),
    rows: (database) =>
      database
        .prepare("SELECT version,name,checksum FROM schema_ledgers WHERE schema_id=? ORDER BY version")
        .all(schemaId),
    record(database, migration) {
      database
        .prepare("INSERT INTO schema_ledgers(schema_id,version,name,checksum,applied_at) VALUES(?,?,?,?,?)")
        .run(schemaId, migration.version, migration.name, migration.checksum, Date.now());
    },
  };
}

/** Whether `name` is a ledger table (never an object of any chain). */
export function isMigrationLedgerObject(name: string): boolean {
  return name === "schema_migrations" || name === SCHEMA_LEDGER_TABLE;
}

/** A published migration chain that shares a database under its schema id. */
export interface SqlSchemaDeclaration {
  readonly schema: string;
  readonly migrations: readonly HashedSqlMigration[];
  /**
   * Names the storage objects (tables, indexes, triggers, views) this chain
   * creates, for example by the prefix every one of them carries. An owned
   * object without the chain's ledger is a foreign or interrupted history.
   */
  owns(objectName: string): boolean;
}

export interface SqlSchemaOutcome {
  readonly schema: string;
  readonly status: "fresh" | "migrated" | "up-to-date";
  readonly appliedVersion: number;
}

/**
 * Slim lifecycle of one named chain in a shared database whose owner is
 * already exclusive and durable: the ledger rules of `applySqlMigrations`
 * under the chain's schema id, plus refusal to adopt objects the chain owns
 * while it has no history. The database's own chain and every other chain are
 * untouched; their objects are not this chain's to judge. Backup, process
 * locks and `:memory:` schema validation stay with a Node owner.
 */
export function migrateSqlSchema(
  database: SqlDatabase,
  declaration: SqlSchemaDeclaration,
  options: Omit<ApplySqlMigrationsOptions, "ledger"> = {},
): SqlSchemaOutcome {
  const scoped: ApplySqlMigrationsOptions = { ...options, ledger: schemaMigrationLedger(declaration.schema) };
  const fail =
    options.fail ??
    ((kind: "history-mismatch" | "newer-schema", message: string) => new SqlMigrationError(kind, message));
  assertContiguousMigrations(declaration.migrations, scoped);
  const before = validateMigrationHistory(database, declaration.migrations, scoped);
  if (!before) {
    const owned = database
      .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .all()
      .filter((row) => !isMigrationLedgerObject(String(row.name)) && declaration.owns(String(row.name)));
    if (owned.length)
      throw fail(
        "history-mismatch",
        `Schema ${declaration.schema} has objects but no migration ledger; refusing to adopt`,
      );
  }
  applySqlMigrations(database, declaration.migrations, scoped);
  if (validateMigrationHistory(database, declaration.migrations, scoped) !== declaration.migrations.length)
    throw fail("history-mismatch", `Schema ${declaration.schema} ledger is incomplete after migration`);
  return {
    schema: declaration.schema,
    status: before === declaration.migrations.length ? "up-to-date" : before > 0 ? "migrated" : "fresh",
    appliedVersion: declaration.migrations.length,
  };
}
