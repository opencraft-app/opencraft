import { mkdirSync, existsSync, openSync, fsyncSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { nodeSqlDatabase, openManagedDatabase, SqliteLifecycleError, acquireProcessWriter, createSqliteBackup, pruneSqliteBackups } from "@opencraft/sqlite-node";
import type { ServerDatabaseSource } from "./repository.js";
import { importServerData } from "./import.js";
import { planServerOpen } from "./history.js";
import { adoptServerLineage, applyExtensionFamilies, coreSchemaValidator, verifyExtensionFamilies } from "./extension-families.js";
import {DEFAULT_SERVER_MIGRATION_COMPOSITION,serverMigrationComposition,type ServerDataContract} from "./migration-composition.js";
export {createServerMigrationComposition,installServerMigrationComposition,installedServerMigrationComposition} from "./migration-composition.js";
export { verifyExtensionFamilies } from "./extension-families.js";
export type {ServerAlternateHistory,ServerDataContract,ServerLedgerIdentity,ServerMigrationComposition,ServerMigrationCompositionInput,ServerMigrationFamily} from "./migration-composition.js";
export { SERVER_MIGRATIONS } from "./migrations.generated.js";

/** Public/default compile-time contract; each opened owner exposes its selected contract. */
export const SERVER_DATA_CONTRACT:ServerDataContract = DEFAULT_SERVER_MIGRATION_COMPOSITION.contract;

export type ServerDatabase = Exclude<ServerDatabaseSource, string> & {
  readonly contract: ServerDataContract;
  close(): Promise<void>;
};

/** Owns the same installation fence used by Headless, including offline admin commands. */
export async function openServerDatabase(directory: string): Promise<ServerDatabase> {
  const composition=serverMigrationComposition(),contract=composition.contract;
  // An invalid family set fails before the installation is touched.
  verifyExtensionFamilies(composition);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireProcessWriter(join(directory, "server.lock"));
  let managed: ReturnType<typeof openManagedDatabase> | undefined;
  try {
    const path = join(directory, "opencraft-server.sqlite");
    if (existsSync(join(directory, ".server-import"))) {
      if (!existsSync(path)) throw new SqliteLifecycleError("io", "Consolidated Server database is missing; preserve recovery files and restore the owner");
      const existing = new DatabaseSync(path, { readOnly: true });
      try {
        if (!existing.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()) {
          throw new SqliteLifecycleError("history-mismatch", "Consolidated Server ledger is missing; refusing to reinitialize");
        }
      } finally { existing.close(); }
    }
    // Core first, then each extension family in its own transaction. A declared
    // adoptable lineage is completed on its own ledger, then adopted into the
    // core and family ledgers before core and the families append.
    const plan = planServerOpen(path, composition);
    let backupPath: string | undefined, adopted = false, forwarded = false;
    if (plan.adopt) {
      const forward = openManagedDatabase({ path, migrations: plan.chain, legacyPolicy: "reject" });
      forward.database.close();
      forwarded = forward.outcome.status !== "up-to-date";
      backupPath = forward.outcome.backupPath;
      const adoption = adoptServerLineage(path, composition, plan.adopt);
      backupPath ??= adoption.backupPath;
      adopted = true;
    }
    const core = plan.adopt ? composition.canonical : plan.chain;
    managed = openManagedDatabase({ path, migrations: core, legacyPolicy: "reject", validateSchema: coreSchemaValidator(composition, core) });
    backupPath ??= managed.outcome.backupPath;
    const database = managed.database, coreStatus = managed.outcome.status;
    const extended = applyExtensionFamilies(database, composition, core, () => {
      // Core's own upgrade snapshot (or the adoption snapshot) already precedes these steps.
      if (backupPath || coreStatus === "fresh") return;
      backupPath = createSqliteBackup(database, path, core.length);
      try { if (backupPath) pruneSqliteBackups(path, 3, backupPath); } catch { /* maintenance only */ }
    });
    const status = coreStatus === "fresh" ? "fresh"
      : adopted && !forwarded && !extended && coreStatus === "up-to-date" ? "adopted"
      : adopted || forwarded || extended ? "migrated" : coreStatus;
    managed = { ...managed, outcome: { ...managed.outcome, status, ...(backupPath ? { backupPath } : {}) } };
    // Retain installation identity even after a current-core-only backup restoration.
    mkdirSync(join(directory, ".server-import"), { recursive: true, mode: 0o700 });
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const imported = importServerData(managed.database, directory, contract);
    if (imported === "migrated") managed = { ...managed, outcome: { ...managed.outcome, status: "migrated" } };
    let closed = false;
    const opened = managed;
    return { database: nodeSqlDatabase(opened.database), outcome: opened.outcome, location: path, contract, async close() {
      if (closed) return;
      opened.database.close();
      release();
      closed = true;
    } };
  } catch (error) {
    try { managed?.database.close(); } finally { await release(); }
    throw error;
  }
}
