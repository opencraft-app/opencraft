import type { SqlDatabase, SqlRow } from "./contract.js";

/**
 * Runtime-neutral migration ledger over the SQL port. It owns only the rules
 * every runtime shares: the `schema_migrations` ledger, contiguous versions,
 * SHA-256 checksums of the published SQL text, refusal of unknown or newer
 * histories and one transaction per applied migration. Backup, process locks,
 * legacy import and schema validation stay with the opening owner.
 * See docs/architecture/platform/storage-ports.md §3.1.
 */
export interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
export interface HashedSqlMigration extends SqlMigration {
  /** Lowercase hex SHA-256 of `sql` exactly as published. */
  readonly checksum: string;
}

export const MIGRATION_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";

export type SqlMigrationErrorKind = "history-mismatch" | "newer-schema";

export class SqlMigrationError extends Error {
  constructor(
    readonly kind: SqlMigrationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SqlMigrationError";
  }
}

/**
 * Where one chain's history is kept. Every single-chain database keeps it in
 * its own `schema_migrations` table (the default). A database that hosts
 * several published chains keeps each further chain's rows under its schema id
 * (`./schema-ledgers`, storage-ports §3.1). The version, name and checksum
 * rules are the same for every ledger.
 */
export interface SqlMigrationLedger {
  /** Creates the ledger's table if it is missing; executed in each migration's transaction. */
  readonly createSql: string;
  /** Whether this chain has a history (the table, or any row of the chain). */
  exists(database: Pick<SqlDatabase, "prepare">): boolean;
  /** The chain's rows (version, name, checksum) in version order. */
  rows(database: Pick<SqlDatabase, "prepare">): SqlRow[];
  record(database: Pick<SqlDatabase, "prepare">, migration: HashedSqlMigration): void;
}

/** The database's own ledger, `schema_migrations`. */
export const DATABASE_MIGRATION_LEDGER: SqlMigrationLedger = {
  createSql: MIGRATION_LEDGER_SQL,
  exists: (database) =>
    !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
  rows: (database) => database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all(),
  record(database, migration) {
    database
      .prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)")
      .run(migration.version, migration.name, migration.checksum, Date.now());
  },
};

export interface SqlMigrationOptions {
  /** Owner error type for ledger refusals; defaults to SqlMigrationError. */
  readonly fail?: (kind: SqlMigrationErrorKind, message: string) => Error;
  /** The chain's ledger; defaults to the database's own `schema_migrations`. */
  readonly ledger?: SqlMigrationLedger;
}

const failWith = (options: SqlMigrationOptions | undefined) =>
  options?.fail ?? ((kind: SqlMigrationErrorKind, message: string) => new SqlMigrationError(kind, message));
const ledgerOf = (options: SqlMigrationOptions | undefined) => options?.ledger ?? DATABASE_MIGRATION_LEDGER;

/** Versions start at 1 and are contiguous; every migration has a name and SQL. */
export function assertContiguousMigrations(migrations: readonly SqlMigration[], options?: SqlMigrationOptions): void {
  if (
    !migrations.length ||
    migrations.some((migration, index) => migration.version !== index + 1 || !migration.name || !migration.sql)
  ) {
    throw failWith(options)("history-mismatch", "Migration versions must start at 1 and be contiguous");
  }
}

/** Checksums each migration with the owner's SHA-256 primitive (node:crypto in Node and in workerd with nodejs_compat). */
export function hashSqlMigrations(
  migrations: readonly SqlMigration[],
  sha256Hex: (text: string) => string,
  options?: SqlMigrationOptions,
): readonly HashedSqlMigration[] {
  assertContiguousMigrations(migrations, options);
  return migrations.map((migration) => ({ ...migration, checksum: sha256Hex(migration.sql) }));
}

export function hasMigrationLedger(database: Pick<SqlDatabase, "prepare">, options?: SqlMigrationOptions): boolean {
  return ledgerOf(options).exists(database);
}

/**
 * Returns the number of applied migrations. Every ledger row must match the
 * declared chain's version, name and checksum; a row beyond the chain is a
 * newer schema. Both refuse rather than adopt or rewrite history.
 */
export function validateMigrationHistory(
  database: Pick<SqlDatabase, "prepare">,
  migrations: readonly HashedSqlMigration[],
  options?: SqlMigrationOptions,
): number {
  const ledger = ledgerOf(options);
  if (!ledger.exists(database)) return 0;
  const rows = ledger.rows(database);
  if (rows.some((row) => Number(row.version) > migrations.length)) {
    throw failWith(options)("newer-schema", "Unsupported newer database migration history");
  }
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || row.version !== index + 1 || row.checksum !== migration.checksum || row.name !== migration.name) {
      throw failWith(options)("history-mismatch", "Unsupported database migration history");
    }
  }
  return rows.length;
}

export function recordSqlMigration(
  database: Pick<SqlDatabase, "prepare">,
  migration: HashedSqlMigration,
  options?: SqlMigrationOptions,
): void {
  ledgerOf(options).record(database, migration);
}

export interface ApplySqlMigrationsOptions extends SqlMigrationOptions {
  /** Runs inside the final migration's transaction, before its ledger row is recorded. */
  readonly validateSchema?: () => void;
}

/**
 * Applies each pending migration in its own `transaction()`: the history is
 * revalidated inside the transaction, so a concurrent or repeated run applies
 * nothing twice. The migration SQL is executed as published, in one `exec`.
 */
export function applySqlMigrations(
  database: SqlDatabase,
  migrations: readonly HashedSqlMigration[],
  options?: ApplySqlMigrationsOptions,
): void {
  const ledger = ledgerOf(options);
  for (const migration of migrations) {
    database.transaction(() => {
      const applied = validateMigrationHistory(database, migrations, options);
      if (migration.version <= applied) return;
      database.exec(ledger.createSql);
      database.exec(migration.sql);
      if (migration.version === migrations.length) options?.validateSchema?.();
      ledger.record(database, migration);
    });
  }
}

/** The published identities a generated contract pins ahead of the SQL it appends. */
export interface SqlMigrationContract {
  readonly baseline: readonly { readonly version: number; readonly name: string; readonly checksum: string }[];
  readonly migrations: readonly SqlMigration[];
}

/**
 * The owner's published prefix followed by the contract's appended migrations,
 * after checking the prefix against the contract's pinned identities: the rule
 * of the Node owner's `resolveStoreMigrations`, with the owner's hash.
 */
export function resolveSqlMigrationContract(
  published: readonly SqlMigration[],
  contract: SqlMigrationContract,
  sha256Hex: (text: string) => string,
  options?: SqlMigrationOptions,
): readonly SqlMigration[] {
  if (
    published.length !== contract.baseline.length ||
    published.some((migration, index) => {
      const expected = contract.baseline[index]!;
      return (
        migration.version !== index + 1 ||
        migration.name !== expected.name ||
        sha256Hex(migration.sql) !== expected.checksum
      );
    })
  )
    throw failWith(options)("history-mismatch", "Published migration prefix differs from its contract");
  return [...published, ...contract.migrations];
}
