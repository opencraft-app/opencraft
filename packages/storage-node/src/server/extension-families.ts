import { createHash } from "node:crypto";
import { constants, DatabaseSync } from "node:sqlite";
import {
  createSchemaValidator,
  createSqliteBackup,
  pruneSqliteBackups,
  sqliteTransaction,
  SqliteLifecycleError,
  verifyManagedDatabaseHistory,
  type Migration,
} from "@opencraft/sqlite-node";
import {
  CORE_FAMILY,
  type ServerAlternateHistory,
  type ServerLedgerIdentity,
  type ServerMigrationComposition,
  type ServerMigrationFamily,
} from "./migration-composition.js";

/**
 * Product extension families beside the Server core ledger
 * (docs/architecture/server/sqlite-lifecycle.md, "Server 产品扩展迁移族").
 * Runs only in the Server owner, under the installation writer fence: never on
 * a network thread. Core keeps `schema_migrations`; each family keeps its own
 * contiguous versions in `schema_extension_migrations`.
 */
export const EXTENSION_LEDGER_TABLE = "schema_extension_migrations";
export const EXTENSION_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_extension_migrations (family TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (family, version)) STRICT";
/** Original linear ledger rows of an adopted lineage, kept for audit; never read as authority. */
export const ADOPTION_RECEIPT_TABLE = "schema_migration_adoptions";
export const ADOPTION_RECEIPT_SQL =
  "CREATE TABLE IF NOT EXISTS schema_migration_adoptions (lineage TEXT PRIMARY KEY NOT NULL, ledger TEXT NOT NULL, adopted_at INTEGER NOT NULL) STRICT";
const CORE_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";
const LEDGER_TABLES = new Set(["schema_migrations", EXTENSION_LEDGER_TABLE, ADOPTION_RECEIPT_TABLE]);

const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");
const mismatch = (message: string, cause?: unknown) =>
  new SqliteLifecycleError("history-mismatch", message, cause === undefined ? undefined : { cause });
const lower = (name: unknown) => (typeof name === "string" ? name.toLowerCase() : "");

export function familyOwning(
  families: readonly ServerMigrationFamily[],
  name: string,
): ServerMigrationFamily | undefined {
  const key = lower(name);
  return families.find((family) => key.startsWith(family.objectPrefix));
}

/** Core owns every object that no family prefix and no ledger names. */
export function coreSchemaValidator(composition: ServerMigrationComposition, chain: readonly Migration[]) {
  return createSchemaValidator(chain.map((m) => m.sql).join(";\n"), {
    select: (name) => !LEDGER_TABLES.has(lower(name)) && !familyOwning(composition.extensions, name),
  });
}

function familySchemaValidator(core: readonly Migration[], family: ServerMigrationFamily, applied: number) {
  return createSchemaValidator([...core, ...family.migrations.slice(0, applied)].map((m) => m.sql).join(";\n"), {
    select: (name) => lower(name).startsWith(family.objectPrefix),
  });
}

// Read-only introspection SQLite itself runs inside ALTER TABLE; no pragma that writes.
const READ_PRAGMAS = new Set([
  "quick_check",
  "integrity_check",
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
]);
const SQLITE_INTERNAL = new Set(["sqlite_master", "sqlite_schema", "sqlite_sequence"]);

/**
 * SQLite authorizer for one family's SQL. Statements are authorized when they
 * are compiled, so a refusal does not depend on data. The family may read any
 * table, but may only create, alter, drop, index or write objects carrying its
 * prefix. Triggers, views, temporary objects, ATTACH, transactions and writing
 * pragmas are refused outright.
 */
function familyAuthorizer(family: ServerMigrationFamily) {
  const owned = (name: unknown) => lower(name).startsWith(family.objectPrefix);
  return (action: number, first: string | null, second: string | null, database: string | null): number => {
    if (database !== null && database !== "main") return constants.SQLITE_DENY;
    let allowed: boolean;
    switch (action) {
      case constants.SQLITE_READ:
      case constants.SQLITE_SELECT:
      case constants.SQLITE_FUNCTION:
      case constants.SQLITE_RECURSIVE:
        allowed = true;
        break;
      case constants.SQLITE_CREATE_TABLE:
      case constants.SQLITE_DROP_TABLE:
      case constants.SQLITE_REINDEX:
        allowed = owned(first);
        break;
      case constants.SQLITE_CREATE_INDEX:
      case constants.SQLITE_DROP_INDEX:
        // A PRIMARY KEY/UNIQUE constraint of an owned table creates SQLite's own autoindex.
        allowed = (owned(first) || lower(first).startsWith("sqlite_autoindex_")) && owned(second);
        break;
      case constants.SQLITE_ALTER_TABLE:
        allowed = owned(second);
        break;
      case constants.SQLITE_INSERT:
      case constants.SQLITE_UPDATE:
      case constants.SQLITE_DELETE:
        allowed = owned(first) || SQLITE_INTERNAL.has(lower(first));
        break;
      case constants.SQLITE_PRAGMA:
        allowed = READ_PRAGMAS.has(lower(first));
        break;
      default:
        allowed = false;
    }
    return allowed ? constants.SQLITE_OK : constants.SQLITE_DENY;
  };
}

function execAsFamily(database: DatabaseSync, family: ServerMigrationFamily, migration: Migration): void {
  database.setAuthorizer(familyAuthorizer(family));
  try {
    database.exec(migration.sql);
  } catch (error) {
    if (/not authorized/i.test(String((error as Error)?.message)))
      throw new SqliteLifecycleError(
        "migration-failed",
        `Server extension family ${family.id} migration ${migration.version} touches an object it does not own`,
        { cause: error },
      );
    throw error;
  } finally {
    database.setAuthorizer(null);
  }
}

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
const objects = (database: DatabaseSync) =>
  database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type,name",
    )
    .all() as unknown as SchemaObject[];

const verified = new WeakSet<ServerMigrationComposition>();
/**
 * Installation-time proof, on an in-memory database, that core declares no
 * object inside a family prefix and that each family, applied after the
 * complete core chain under its authorizer, leaves every core object unchanged
 * and creates only objects it owns. Repeated for each new composition object.
 */
export function verifyExtensionFamilies(composition: ServerMigrationComposition): void {
  if (!composition.extensions.length || verified.has(composition)) return;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(composition.canonical.map((m) => m.sql).join(";\n"));
    const core = objects(database);
    const claimed = core.find(
      (object) => familyOwning(composition.extensions, object.name) || LEDGER_TABLES.has(lower(object.name)),
    );
    if (claimed) throw mismatch(`Server core object ${claimed.name} is inside an extension family prefix`);
    for (const family of composition.extensions) {
      for (const migration of family.migrations) execAsFamily(database, family, migration);
      const after = objects(database);
      const coreAfter = after.filter((object) => !familyOwning(composition.extensions, object.name));
      if (JSON.stringify(coreAfter) !== JSON.stringify(core))
        throw mismatch(`Server extension family ${family.id} changes a core-owned object`);
      const position = composition.extensions.indexOf(family);
      const foreign = after.find((object) => {
        const owner = familyOwning(composition.extensions, object.name);
        return (
          !!owner &&
          (composition.extensions.indexOf(owner) > position || !lower(object.tbl_name).startsWith(owner.objectPrefix))
        );
      });
      if (foreign) throw mismatch(`Server extension family ${family.id} creates ${foreign.name} outside its ownership`);
    }
  } finally {
    database.close();
  }
  verified.add(composition);
}

function normalizeTable(sql: unknown): string {
  return String(sql)
    .replace(/^CREATE TABLE IF NOT EXISTS /i, "CREATE TABLE ")
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/g, (token) => (/^\s/.test(token) ? "" : token));
}
function tableDefinition(database: DatabaseSync, name: string): string | undefined {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row ? normalizeTable(row.sql) : undefined;
}
function assertLedgerTable(database: DatabaseSync, name: string, sql: string): boolean {
  const definition = tableDefinition(database, name);
  if (definition === undefined) return false;
  if (definition !== normalizeTable(sql)) throw mismatch(`Server ledger table ${name} has an unexpected definition`);
  return true;
}

/**
 * Validates every family ledger row: a family the composition does not declare,
 * a gap, or a changed name or checksum refuses; a version above the declared
 * family is a newer schema. Returns each declared family's applied count.
 */
export function readFamilyLedger(database: DatabaseSync, composition: ServerMigrationComposition): Map<string, number> {
  const applied = new Map(composition.extensions.map((family) => [family.id, 0]));
  if (!assertLedgerTable(database, EXTENSION_LEDGER_TABLE, EXTENSION_LEDGER_SQL)) return applied;
  const rows = database
    .prepare("SELECT family,version,name,checksum FROM schema_extension_migrations ORDER BY family,version")
    .all();
  for (const row of rows) {
    const family = composition.extensions.find((entry) => entry.id === row.family);
    if (!family) throw mismatch(`Unknown Server extension family recorded: ${String(row.family)}`);
    const count = applied.get(family.id)!;
    if (Number(row.version) > family.migrations.length)
      throw new SqliteLifecycleError("newer-schema", `Unsupported newer Server extension family history: ${family.id}`);
    const expected = family.migrations[count];
    if (!expected || row.version !== count + 1 || row.name !== expected.name || row.checksum !== digest(expected.sql))
      throw mismatch(`Server extension family ${family.id} ledger does not match its published migrations`);
    applied.set(family.id, count + 1);
  }
  return applied;
}

/**
 * Applies each family's pending migrations after core, in declaration order,
 * one transaction per family. The family's objects are verified before its
 * ledger rows commit, and core is verified again once any family changed.
 */
export function applyExtensionFamilies(
  database: DatabaseSync,
  composition: ServerMigrationComposition,
  core: readonly Migration[],
  backup?: () => void,
): boolean {
  const before = readFamilyLedger(database, composition);
  const pending = composition.extensions.filter((family) => before.get(family.id)! < family.migrations.length);
  if (pending.length) backup?.();
  for (const family of pending) {
    sqliteTransaction(database, () => {
      database.exec(EXTENSION_LEDGER_SQL);
      const applied = readFamilyLedger(database, composition).get(family.id)!;
      const record = database.prepare(
        "INSERT INTO schema_extension_migrations(family,version,name,checksum,applied_at) VALUES(?,?,?,?,?)",
      );
      for (const migration of family.migrations.slice(applied)) {
        execAsFamily(database, family, migration);
        record.run(family.id, migration.version, migration.name, digest(migration.sql), Date.now());
      }
      familySchemaValidator(core, family, family.migrations.length)(database);
    });
  }
  const after = readFamilyLedger(database, composition);
  for (const family of composition.extensions) {
    if (after.get(family.id) !== family.migrations.length)
      throw mismatch(`Server extension family ${family.id} is incomplete after migration`);
    familySchemaValidator(core, family, family.migrations.length)(database);
  }
  if (pending.length) coreSchemaValidator(composition, core)(database);
  return pending.length > 0;
}

export type AdoptableLineage = ServerAlternateHistory & {
  readonly adopts: readonly (readonly ServerLedgerIdentity[])[];
};

/**
 * Rewrites the ledger bookkeeping of a database whose complete linear ledger
 * equals a declared adoptable lineage into the core and family ledgers. Schema
 * objects, business rows and published SQL are untouched. Verified before any
 * write: exact ledger rows, no family ledger yet, and the strict structure of
 * the covered core prefix and of each covered family prefix. Then a recovery
 * snapshot, and one transaction that re-checks the rows, keeps the original
 * rows as a receipt and records each identity with its original applied_at.
 * Once committed the core ledger is a canonical prefix, so a repeated open
 * takes the ordinary path: adoption is idempotent by construction.
 */
export function adoptServerLineage(
  path: string,
  composition: ServerMigrationComposition,
  lineage: AdoptableLineage,
  keep = 3,
): { readonly backupPath?: string } {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    if (!assertLedgerTable(database, "schema_migrations", CORE_LEDGER_SQL))
      throw mismatch("Server lineage ledger is missing");
    const read = () =>
      database
        .prepare("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version")
        .all() as Array<{
        version: number;
        name: string;
        checksum: string;
        applied_at: number;
      }>;
    const rows = read();
    if (
      rows.length !== lineage.migrations.length ||
      rows.some((row, index) => {
        const step = lineage.migrations[index]!;
        return row.version !== index + 1 || row.name !== step.name || row.checksum !== digest(step.sql);
      })
    )
      throw mismatch(`Server ledger does not equal the complete lineage ${lineage.id}`);
    if (
      assertLedgerTable(database, EXTENSION_LEDGER_TABLE, EXTENSION_LEDGER_SQL) &&
      database.prepare("SELECT 1 FROM schema_extension_migrations LIMIT 1").get()
    )
      throw mismatch(`Server lineage ${lineage.id} already has extension family rows`);
    if (
      assertLedgerTable(database, ADOPTION_RECEIPT_TABLE, ADOPTION_RECEIPT_SQL) &&
      database.prepare("SELECT 1 FROM schema_migration_adoptions WHERE lineage=?").get(lineage.id)
    )
      throw mismatch(`Server lineage ${lineage.id} was already adopted`);
    const identities = lineage.adopts.flat();
    const covered = (family: string) => identities.filter((identity) => identity.family === family).length;
    const core = composition.canonical.slice(0, covered(CORE_FAMILY));
    // The reordered or merged published steps must have produced exactly the
    // canonical structure of what they adopt; otherwise nothing is written.
    coreSchemaValidator(composition, core)(database);
    for (const family of composition.extensions) familySchemaValidator(core, family, covered(family.id))(database);
    if (
      identities.some(
        (identity) =>
          identity.family !== CORE_FAMILY && !composition.extensions.some((family) => family.id === identity.family),
      )
    )
      throw mismatch(`Server lineage ${lineage.id} adopts an undeclared family`);
    const backupPath = createSqliteBackup(database, path, core.length);
    sqliteTransaction(database, () => {
      if (JSON.stringify(read()) !== JSON.stringify(rows)) throw mismatch("Server ledger changed during adoption");
      database.exec(EXTENSION_LEDGER_SQL);
      database.exec(ADOPTION_RECEIPT_SQL);
      database
        .prepare("INSERT INTO schema_migration_adoptions(lineage,ledger,adopted_at) VALUES(?,?,?)")
        .run(lineage.id, JSON.stringify(rows), Date.now());
      database.exec("DELETE FROM schema_migrations");
      const coreRow = database.prepare(
        "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
      );
      const familyRow = database.prepare(
        "INSERT INTO schema_extension_migrations(family,version,name,checksum,applied_at) VALUES(?,?,?,?,?)",
      );
      for (const [index, targets] of lineage.adopts.entries()) {
        for (const target of targets) {
          const migration =
            target.family === CORE_FAMILY
              ? composition.canonical[target.version - 1]!
              : composition.extensions.find((family) => family.id === target.family)!.migrations[target.version - 1]!;
          if (target.family === CORE_FAMILY)
            coreRow.run(migration.version, migration.name, digest(migration.sql), rows[index]!.applied_at);
          else
            familyRow.run(
              target.family,
              migration.version,
              migration.name,
              digest(migration.sql),
              rows[index]!.applied_at,
            );
        }
      }
      verifyManagedDatabaseHistory(database, core);
      const families = readFamilyLedger(database, composition);
      for (const family of composition.extensions)
        if (families.get(family.id) !== covered(family.id))
          throw mismatch(`Server lineage ${lineage.id} adoption is incomplete`);
    });
    try {
      if (backupPath) pruneSqliteBackups(path, keep, backupPath);
    } catch {
      // The adoption committed; an old recovery point that was not removed is only maintenance.
    }
    return backupPath ? { backupPath } : {};
  } finally {
    database.close();
  }
}
