import { DatabaseSync } from "node:sqlite";
import { openConnection } from "./connection.js";
import { pruneBackups } from "./backup.js";
import { assertRecoveryState, beginRecovery, finishRecovery, readRecovery } from "./recovery.js";
import { classifyError, SqliteLifecycleError } from "./errors.js";
import { applyMigrations, hasLedger, LEDGER_SQL, prepareMigrations, recordMigration, schemaFingerprint, transaction, validateHistory, type Migration } from "./migrations.js";

export interface DatabaseOutcome {
  readonly status: "fresh" | "up-to-date" | "migrated" | "adopted" | "moved-aside";
  readonly appliedVersion: number;
  readonly backupPath?: string;
  readonly movedAsidePaths: readonly string[];
  readonly maintenanceWarnings?: readonly "backup-cleanup-failed"[];
}
export interface ManagedDatabaseOptions {
  readonly path: string;
  readonly migrations: readonly Migration[];
  readonly backup?: { readonly keep?: number };
  /** Owner validates the final physical schema before recording the final migration. */
  readonly validateSchema?: (database: DatabaseSync) => void;
  /** Preserve owners that rejected unledgered or unknown structures before managed opening. */
  readonly legacyPolicy?: "reject-unknown" | "reject";
  /** Owner-declared known unledgered schema; never used for ledgered databases. */
  readonly legacyMigration?: {
    readonly accepts: (fingerprint: string, objects: readonly { readonly type: string; readonly name: string; readonly sql: string }[]) => boolean;
    readonly migrate: (database: DatabaseSync) => void;
  };
}

function schemaObjects(database: DatabaseSync) {
  return database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name!='schema_migrations' ORDER BY type,name")
    .all() as unknown as Array<{ type: string; name: string; sql: string }>;
}

/** Ignore layout whitespace, not whitespace inside SQL literals or identifiers. */
function normalizeDefinition(definition: string): string {
  return definition.replace(/^CREATE (TABLE|INDEX) IF NOT EXISTS /i, "CREATE $1 ")
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/g, token => /^\s/.test(token) ? "" : token);
}

/** Strict owner-declared object validation, including constraints and index SQL. */
export function createSchemaValidator(sql: string): (database: DatabaseSync) => void {
  return database => {
    const target = openConnection(":memory:");
    try {
      target.exec(sql);
      const normalize = (db: DatabaseSync) => schemaObjects(db).map(object => ({ ...object, sql: normalizeDefinition(object.sql) }));
      if (JSON.stringify(normalize(database)) !== JSON.stringify(normalize(target))) {
        throw new SqliteLifecycleError("history-mismatch", "Database schema does not match its owner migrations");
      }
    } finally { target.close(); }
  };
}

/** Explicit opt-in for owners whose old constructors only created missing objects. */
export function createMissingLegacyObjects(sql: string): NonNullable<ManagedDatabaseOptions["legacyMigration"]> {
  return {
    accepts: (_fingerprint, objects) => {
      const target = openConnection(":memory:");
      try {
        target.exec(sql);
        const expected = schemaObjects(target);
        return objects.length > 0 && objects.every(object => expected.some(candidate =>
          candidate.type === object.type && candidate.name === object.name && normalizeDefinition(candidate.sql) === normalizeDefinition(object.sql)));
      } finally { target.close(); }
    },
    migrate: database => database.exec(sql.replace(/CREATE (TABLE|INDEX) /g, "CREATE $1 IF NOT EXISTS ")),
  };
}

export function openManagedDatabase(options: ManagedDatabaseOptions): { database: DatabaseSync; outcome: DatabaseOutcome } {
  let database: DatabaseSync | undefined;
  try {
    const migrations = prepareMigrations(options.migrations);
    const validateSchema = options.validateSchema ?? createSchemaValidator(migrations.map(m => m.sql).join(";\n"));
    const keep = options.backup?.keep ?? 3;
    if (!Number.isSafeInteger(keep) || keep < 1) throw new SqliteLifecycleError("io", "Backup keep must be a positive integer");
    assertRecoveryState(options.path);
    database = openConnection(options.path);
    const applied = validateHistory(database, migrations);
    let recovery = readRecovery(options.path, migrations, applied);
    const fingerprint = schemaFingerprint(database);
    const nonempty = fingerprint !== "[]";
    if (!nonempty && !hasLedger(database)) assertRecoveryState(options.path, true);
    const legacy = !hasLedger(database) && nonempty;
    let status: DatabaseOutcome["status"] = applied === migrations.length ? "up-to-date" : nonempty || applied > 0 ? "migrated" : "fresh";
    let backupPath: string | undefined;
    if (legacy) {
      if (options.legacyPolicy === "reject") throw new SqliteLifecycleError("unsupported-legacy", "This owner requires a database migration ledger");
      const target = openConnection(":memory:");
      let targetFingerprint: string;
      try { applyMigrations(target, migrations); targetFingerprint = schemaFingerprint(target); }
      finally { target.close(); }
      const matches = fingerprint === targetFingerprint;
      const objects = schemaObjects(database);
      const legacyMigration = !matches && options.legacyMigration?.accepts(fingerprint, objects) ? options.legacyMigration : undefined;
      if (!matches && !legacyMigration) throw new SqliteLifecycleError("unsupported-legacy", "Unknown owner database schema");
      recovery = beginRecovery(database, options.path, migrations, recovery);
      backupPath = recovery?.backupPath;
      if (matches || legacyMigration) {
        const connection = database;
        transaction(connection, () => {
          if (hasLedger(connection) || schemaFingerprint(connection) !== fingerprint) throw new SqliteLifecycleError("history-mismatch", "Legacy schema changed during adoption");
          if (legacyMigration && JSON.stringify(schemaObjects(connection)) !== JSON.stringify(objects)) throw new SqliteLifecycleError("history-mismatch", "Legacy objects changed during migration");
          legacyMigration?.migrate(connection);
          if (schemaFingerprint(connection) !== targetFingerprint) throw new SqliteLifecycleError("unsupported-legacy", "Owner legacy migration did not produce the target schema");
          validateSchema(connection);
          connection.exec(LEDGER_SQL);
          for (const migration of migrations) recordMigration(connection, migration);
        });
        status = legacyMigration ? "migrated" : "adopted";
      }
    } else if (applied < migrations.length) {
      if (nonempty || hasLedger(database)) {
        recovery = beginRecovery(database, options.path, migrations, recovery);
        backupPath = recovery?.backupPath;
      }
      applyMigrations(database, migrations, validateSchema);
    }
    validateHistory(database, migrations);
    validateSchema(database);
    backupPath ??= recovery?.backupPath;
    const maintenanceWarnings: "backup-cleanup-failed"[] = [];
    try {
      if (backupPath) pruneBackups(options.path, keep, backupPath);
      if (recovery) finishRecovery(options.path);
    } catch { maintenanceWarnings.push("backup-cleanup-failed"); }
    return { database, outcome: { status, appliedVersion: migrations.length, ...(backupPath ? { backupPath } : {}), movedAsidePaths: [],
      ...(maintenanceWarnings.length ? { maintenanceWarnings } : {}) } };
  } catch (error) {
    database?.close();
    throw classifyError(error);
  }
}
