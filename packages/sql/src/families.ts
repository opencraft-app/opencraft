import type { SqlDatabase } from "./contract.js";
import {
  SqlMigrationError,
  type HashedSqlMigration,
  type SqlMigrationErrorKind,
  type SqlMigrationOptions,
} from "./migrations.js";

/**
 * Several published migration chains in one database, each on its own ledger
 * (docs/architecture/platform/workspace-host-split.md §4.1). An owner whose
 * stores were separate files, each with its own `schema_migrations`, keeps
 * every chain exactly as published when the stores share one database (one
 * Durable Object, or a merged Node file): chain `id` records its versions in
 * `schema_family_migrations(family, version, ...)`, the same shape as the
 * Server's extension-family ledger, and no chain is renumbered or rewritten.
 *
 * The rules are the single-ledger runner's, per family: contiguous versions,
 * SHA-256 checksums of the published text, refusal of a changed history
 * (`history-mismatch`) or of versions beyond the declared chain
 * (`newer-schema`), one transaction per applied migration with the family's
 * history revalidated inside it. In addition: a family in the ledger that this
 * build does not declare is `newer-schema`; a database that already holds a
 * single-chain `schema_migrations` ledger, or objects without any ledger, is
 * not adopted (`history-mismatch`). Chains must create disjoint objects; a
 * collision fails the migration that creates the second object.
 */
export interface SqlMigrationFamily {
  /** Ledger key: lowercase letters, digits and dashes. */
  readonly id: string;
  readonly migrations: readonly HashedSqlMigration[];
}

export const MIGRATION_FAMILY_LEDGER_TABLE = "schema_family_migrations";
export const MIGRATION_FAMILY_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_family_migrations (family TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (family, version)) STRICT";

export interface SqlMigrationFamilyOptions extends SqlMigrationOptions {
  /** Objects the runtime itself keeps in the database (Durable Object `_cf_*` tables). */
  readonly ownedByRuntime?: (name: string) => boolean;
}

/** One family after migration: how many of its versions this call applied, and its version now. */
export interface SqlMigrationFamilyOutcome {
  readonly id: string;
  readonly applied: number;
  readonly version: number;
}

const FAMILY_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const failWith = (options: SqlMigrationOptions | undefined) =>
  options?.fail ?? ((kind: SqlMigrationErrorKind, message: string) => new SqlMigrationError(kind, message));

function assertFamilies(families: readonly SqlMigrationFamily[], options?: SqlMigrationOptions): void {
  const fail = failWith(options);
  const seen = new Set<string>();
  if (!families.length) throw fail("history-mismatch", "At least one migration family is required");
  for (const family of families) {
    if (!FAMILY_ID.test(family.id ?? "") || seen.has(family.id))
      throw fail("history-mismatch", "Migration family ids must be unique lowercase names");
    seen.add(family.id);
    if (
      !family.migrations.length ||
      family.migrations.some(
        (migration, index) =>
          migration.version !== index + 1 ||
          !migration.name ||
          !migration.sql ||
          !/^[a-f0-9]{64}$/u.test(migration.checksum ?? ""),
      )
    )
      throw fail("history-mismatch", `Migration family ${family.id} must start at 1, be contiguous and checksummed`);
  }
}

const tableExists = (database: Pick<SqlDatabase, "prepare">, name: string) =>
  !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Ledger rows by family, in version order; empty before the first migration. */
export function readSqlMigrationFamilies(
  database: Pick<SqlDatabase, "prepare">,
): Readonly<Record<string, readonly { version: number; name: string; checksum: string }[]>> {
  if (!tableExists(database, MIGRATION_FAMILY_LEDGER_TABLE)) return {};
  const rows: Record<string, { version: number; name: string; checksum: string }[]> = {};
  for (const row of database
    .prepare("SELECT family,version,name,checksum FROM schema_family_migrations ORDER BY family,version")
    .all())
    (rows[String(row.family)] ??= []).push({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    });
  return rows;
}

/**
 * Validates the whole ledger against the declared families and returns the
 * number of applied versions per family. Refuses rather than adopts.
 */
export function validateSqlMigrationFamilies(
  database: Pick<SqlDatabase, "prepare">,
  families: readonly SqlMigrationFamily[],
  options?: SqlMigrationFamilyOptions,
): ReadonlyMap<string, number> {
  const fail = failWith(options);
  if (tableExists(database, "schema_migrations"))
    throw fail("history-mismatch", "A single-chain database is not adopted into migration families");
  const ledger = readSqlMigrationFamilies(database);
  if (!tableExists(database, MIGRATION_FAMILY_LEDGER_TABLE)) {
    const foreign = database
      .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .all()
      .map((row) => String(row.name))
      .filter((name) => !options?.ownedByRuntime?.(name));
    if (foreign.length) throw fail("history-mismatch", "Database objects without a migration ledger are not adopted");
  }
  const declared = new Map(families.map((family) => [family.id, family]));
  for (const id of Object.keys(ledger))
    if (!declared.has(id)) throw fail("newer-schema", `Unsupported migration family ${id}`);
  const applied = new Map<string, number>();
  for (const family of families) {
    const rows = ledger[family.id] ?? [];
    if (rows.some((row) => row.version > family.migrations.length))
      throw fail("newer-schema", `Unsupported newer migration history for ${family.id}`);
    for (const [index, row] of rows.entries()) {
      const migration = family.migrations[index];
      if (!migration || row.version !== index + 1 || row.name !== migration.name || row.checksum !== migration.checksum)
        throw fail("history-mismatch", `Unsupported migration history for ${family.id}`);
    }
    applied.set(family.id, rows.length);
  }
  return applied;
}

/**
 * Applies every pending migration of every family, families in declared order,
 * each migration in its own `transaction()` that revalidates the ledger first,
 * so a repeated or concurrent run applies nothing twice.
 */
export function applySqlMigrationFamilies(
  database: SqlDatabase,
  families: readonly SqlMigrationFamily[],
  options?: SqlMigrationFamilyOptions,
): readonly SqlMigrationFamilyOutcome[] {
  assertFamilies(families, options);
  const before = validateSqlMigrationFamilies(database, families, options);
  for (const family of families)
    for (const migration of family.migrations)
      database.transaction(() => {
        if (migration.version <= validateSqlMigrationFamilies(database, families, options).get(family.id)!) return;
        database.exec(MIGRATION_FAMILY_LEDGER_SQL);
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO schema_family_migrations(family,version,name,checksum,applied_at) VALUES(?,?,?,?,?)")
          .run(family.id, migration.version, migration.name, migration.checksum, Date.now());
      });
  return families.map((family) => ({
    id: family.id,
    applied: family.migrations.length - before.get(family.id)!,
    version: family.migrations.length,
  }));
}
