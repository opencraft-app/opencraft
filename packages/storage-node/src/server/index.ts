import { mkdirSync, existsSync, openSync, fsyncSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openManagedDatabase, SqliteLifecycleError, acquireProcessWriter } from "@opencraft/sqlite-node";
import type { ServerDatabaseSource } from "./repository.js";
import { importServerData } from "./import.js";
import { serverMigrationsFor } from "./history.js";
import {DEFAULT_SERVER_MIGRATION_COMPOSITION,serverMigrationComposition,type ServerDataContract} from "./migration-composition.js";
export {createServerMigrationComposition,installServerMigrationComposition,installedServerMigrationComposition} from "./migration-composition.js";
export type {ServerDataContract,ServerMigrationComposition,ServerMigrationCompositionInput} from "./migration-composition.js";
export { SERVER_MIGRATIONS } from "./migrations.generated.js";

/** Public/default compile-time contract; each opened owner exposes its selected contract. */
export const SERVER_DATA_CONTRACT:ServerDataContract = DEFAULT_SERVER_MIGRATION_COMPOSITION.contract;

export type ServerDatabase = Exclude<ServerDatabaseSource, string> & {
  readonly contract: ServerDataContract;
  close(): Promise<void>;
};

/** Owns the same installation fence used by Headless, including offline admin commands. */
export async function openServerDatabase(directory: string): Promise<ServerDatabase> {
  const contract=serverMigrationComposition().contract;
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
    managed = openManagedDatabase({ path, migrations: serverMigrationsFor(path), legacyPolicy: "reject" });
    // Retain installation identity even after a current-core-only backup restoration.
    mkdirSync(join(directory, ".server-import"), { recursive: true, mode: 0o700 });
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const imported = importServerData(managed.database, directory, contract);
    if (imported === "migrated") managed = { ...managed, outcome: { ...managed.outcome, status: "migrated" } };
    let closed = false;
    return { ...managed, contract, async close() {
      if (closed) return;
      managed!.database.close();
      release();
      closed = true;
    } };
  } catch (error) {
    try { managed?.database.close(); } finally { await release(); }
    throw error;
  }
}
