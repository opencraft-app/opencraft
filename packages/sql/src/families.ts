import type { SqlDatabase } from "./contract.js";
import {
  applySqlMigrations,
  SqlMigrationError,
  type HashedSqlMigration,
  type SqlMigrationErrorKind,
  type SqlMigrationLedger,
} from "./migrations.js";

/**
 * Several published migration chains in one database
 * (docs/architecture/platform/storage-ports.md §3.1 "同库多条迁移链"): the one
 * runtime-neutral primitive every owner uses for it.
 *
 * Each chain is a **family**: its versions, names and SHA-256 checksums are
 * exactly those its other owners apply, and it records them in a shared family
 * ledger table `(family, version, name, checksum, applied_at)` under its id.
 * The table name is the owner's (it is part of every database it has written):
 *   - `schema_extension_migrations` — the Node Server core's product extension
 *     families (published; `@opencraft/storage-node` delegates its ledger rules here);
 *   - `schema_family_migrations` — the Durable Object owners (AccountCore,
 *     WorkspaceHost), `MIGRATION_FAMILY_LEDGER_TABLE`.
 * Two compositions:
 *   - `families`: the database holds only families (WorkspaceHost). A
 *     single-chain `schema_migrations` ledger, or objects without any ledger, are
 *     never adopted.
 *   - `beside-main`: a main chain keeps the database's own `schema_migrations`
 *     (applied by its owner, before the families) and owns every object no family
 *     owns (AccountCore's model policy, the Server core). Each family declares its
 *     objects (`owns`, for example a prefix); a family's object without that
 *     family's ledger is never adopted.
 * Rules shared by both: contiguous versions; a changed name or checksum or a gap
 * is `history-mismatch`; a version beyond the declared chain, or a family in the
 * ledger that this build does not declare, is `newer-schema`; every migration
 * runs in its own `transaction()` that revalidates its family first. Backup,
 * locks, authorizers and schema validation stay with a Node owner.
 */
export interface SqlMigrationFamily {
  /** Ledger key: lowercase letters, digits and dashes. */
  readonly id: string;
  readonly migrations: readonly HashedSqlMigration[];
  /** The storage objects (tables, indexes, triggers, views) this family creates. Required beside a main chain. */
  owns?(objectName: string): boolean;
}

/** The family ledger table of the Durable Object owners (AccountCore, WorkspaceHost). */
export const MIGRATION_FAMILY_LEDGER_TABLE = "schema_family_migrations";

const FAMILY_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const LEDGER_TABLE = /^schema_[a-z][a-z0-9_]{0,62}$/u;

/** The family ledger's definition under `table` (the Server's `schema_extension_migrations` text for that name). */
export function migrationFamilyLedgerSql(table: string): string {
  if (!LEDGER_TABLE.test(table) || table === "schema_migrations")
    throw new SqlMigrationError("history-mismatch", "Invalid migration family ledger table");
  return `CREATE TABLE IF NOT EXISTS ${table} (family TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (family, version)) STRICT`;
}

/** Whether `name` is a ledger table: the main chain's or the family ledger `table`. */
export function isMigrationLedgerObject(name: string, table: string = MIGRATION_FAMILY_LEDGER_TABLE): boolean {
  return name === "schema_migrations" || name === table;
}

const tableExists = (database: Pick<SqlDatabase, "prepare">, name: string) =>
  !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** One family's ledger in `table`, for `applySqlMigrations({ ledger })`. */
export function migrationFamilyLedger(table: string, family: string): SqlMigrationLedger {
  const createSql = migrationFamilyLedgerSql(table);
  if (!FAMILY_ID.test(family))
    throw new SqlMigrationError("history-mismatch", "Migration family id must be lowercase letters, digits and dashes");
  return {
    createSql,
    exists: (database) =>
      tableExists(database, table) && !!database.prepare(`SELECT 1 FROM ${table} WHERE family=? LIMIT 1`).get(family),
    rows: (database) =>
      database.prepare(`SELECT version,name,checksum FROM ${table} WHERE family=? ORDER BY version`).all(family),
    record(database, migration) {
      database
        .prepare(`INSERT INTO ${table}(family,version,name,checksum,applied_at) VALUES(?,?,?,?,?)`)
        .run(family, migration.version, migration.name, migration.checksum, Date.now());
    },
  };
}

/** Why a family history was refused; an owner with its own messages maps it (the Server core does). */
export type SqlMigrationFamilyRefusal =
  "unknown-family" | "newer" | "changed" | "single-chain" | "unledgered" | "incomplete";

export interface SqlMigrationFamilyLedgerOptions {
  /** The family ledger table. */
  readonly table: string;
  /** Owner error type; defaults to SqlMigrationError with the message given. */
  readonly fail?: (
    kind: SqlMigrationErrorKind,
    message: string,
    detail: { readonly reason: SqlMigrationFamilyRefusal; readonly family?: string },
  ) => Error;
}

export interface SqlMigrationFamilyOptions extends SqlMigrationFamilyLedgerOptions {
  readonly composition: "families" | "beside-main";
  /** Objects the runtime itself keeps in the database (Durable Object `_cf_*` tables). */
  readonly ownedByRuntime?: (name: string) => boolean;
}

/** One family after migration. */
export interface SqlMigrationFamilyOutcome {
  readonly id: string;
  readonly status: "fresh" | "migrated" | "up-to-date";
  /** Versions this call applied. */
  readonly applied: number;
  readonly version: number;
}

const refuse = (
  options: SqlMigrationFamilyLedgerOptions,
  kind: SqlMigrationErrorKind,
  message: string,
  reason: SqlMigrationFamilyRefusal,
  family?: string,
) =>
  options.fail?.(kind, message, { reason, ...(family === undefined ? {} : { family }) }) ??
  new SqlMigrationError(kind, message);

function assertFamilies(
  families: readonly SqlMigrationFamily[],
  composition?: SqlMigrationFamilyOptions["composition"],
) {
  const seen = new Set<string>();
  for (const family of families) {
    if (!FAMILY_ID.test(family.id ?? "") || seen.has(family.id))
      throw new SqlMigrationError("history-mismatch", "Migration family ids must be unique lowercase names");
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
      throw new SqlMigrationError(
        "history-mismatch",
        `Migration family ${family.id} must start at 1, be contiguous and checksummed`,
      );
    if (composition === "beside-main" && typeof family.owns !== "function")
      throw new SqlMigrationError("history-mismatch", `Migration family ${family.id} must declare its objects`);
  }
}

/**
 * Validates every row of the family ledger in `(family, version)` order: a
 * family not declared, a gap, or a changed name or checksum refuses; a version
 * above the declared family is a newer schema. Returns each declared family's
 * applied count. Only the ledger rows; the composition rules are
 * `validateSqlMigrationFamilies`.
 */
export function readSqlMigrationFamilyLedger(
  database: Pick<SqlDatabase, "prepare">,
  families: readonly SqlMigrationFamily[],
  options: SqlMigrationFamilyLedgerOptions,
): Map<string, number> {
  const table = options.table;
  migrationFamilyLedgerSql(table);
  const applied = new Map(families.map((family) => [family.id, 0]));
  if (!tableExists(database, table)) return applied;
  for (const row of database
    .prepare(`SELECT family,version,name,checksum FROM ${table} ORDER BY family,version`)
    .all()) {
    const id = String(row.family);
    const family = families.find((entry) => entry.id === id);
    if (!family) throw refuse(options, "newer-schema", `Unsupported migration family ${id}`, "unknown-family", id);
    const count = applied.get(id)!;
    if (Number(row.version) > family.migrations.length)
      throw refuse(options, "newer-schema", `Unsupported newer migration history for ${id}`, "newer", id);
    const expected = family.migrations[count];
    if (
      !expected ||
      Number(row.version) !== count + 1 ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    )
      throw refuse(options, "history-mismatch", `Unsupported migration history for ${id}`, "changed", id);
    applied.set(id, count + 1);
  }
  return applied;
}

/** The ledger rows by family, in version order; empty before the first migration. */
export function sqlMigrationFamilyRows(
  database: Pick<SqlDatabase, "prepare">,
  table: string,
): Readonly<Record<string, readonly { version: number; name: string; checksum: string }[]>> {
  migrationFamilyLedgerSql(table);
  if (!tableExists(database, table)) return {};
  const rows: Record<string, { version: number; name: string; checksum: string }[]> = {};
  for (const row of database.prepare(`SELECT family,version,name,checksum FROM ${table} ORDER BY family,version`).all())
    (rows[String(row.family)] ??= []).push({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    });
  return rows;
}

/**
 * The ledger rows plus the composition's adoption rules: never adopt a
 * single-chain database or ledgerless objects (`families`), never adopt a
 * family's objects without its ledger (both).
 */
export function validateSqlMigrationFamilies(
  database: Pick<SqlDatabase, "prepare">,
  families: readonly SqlMigrationFamily[],
  options: SqlMigrationFamilyOptions,
): Map<string, number> {
  assertFamilies(families, options.composition);
  const table = options.table;
  const objects = database
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !isMigrationLedgerObject(name, table) && !options.ownedByRuntime?.(name));
  if (options.composition === "families") {
    if (tableExists(database, "schema_migrations"))
      throw refuse(
        options,
        "history-mismatch",
        "A single-chain database is not adopted into migration families",
        "single-chain",
      );
    if (!tableExists(database, table) && objects.length)
      throw refuse(
        options,
        "history-mismatch",
        "Database objects without a migration ledger are not adopted",
        "unledgered",
      );
  }
  const applied = readSqlMigrationFamilyLedger(database, families, options);
  for (const family of families)
    if (!applied.get(family.id) && family.owns && objects.some((name) => family.owns!(name)))
      throw refuse(
        options,
        "history-mismatch",
        `Migration family ${family.id} has objects but no migration ledger; refusing to adopt`,
        "unledgered",
        family.id,
      );
  return applied;
}

/**
 * Applies every pending migration of every family, families in declared order.
 * Beside a main chain, the owner applies the main chain first.
 */
export function applySqlMigrationFamilies(
  database: SqlDatabase,
  families: readonly SqlMigrationFamily[],
  options: SqlMigrationFamilyOptions,
): readonly SqlMigrationFamilyOutcome[] {
  const before = validateSqlMigrationFamilies(database, families, options);
  const fail = (kind: SqlMigrationErrorKind, message: string) =>
    refuse(options, kind, message, kind === "newer-schema" ? "newer" : "changed");
  for (const family of families)
    applySqlMigrations(database, family.migrations, { ledger: migrationFamilyLedger(options.table, family.id), fail });
  const after = readSqlMigrationFamilyLedger(database, families, options);
  return families.map((family) => {
    const version = family.migrations.length,
      start = before.get(family.id)!;
    if (after.get(family.id) !== version)
      throw refuse(
        options,
        "history-mismatch",
        `Migration family ${family.id} is incomplete after migration`,
        "incomplete",
        family.id,
      );
    return {
      id: family.id,
      status: start === version ? "up-to-date" : start > 0 ? "migrated" : "fresh",
      applied: version - start,
      version,
    };
  });
}
