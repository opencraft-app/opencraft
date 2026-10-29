import { createHash } from "node:crypto";
import { mkdirSync, existsSync, openSync, fsyncSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openManagedDatabase, SqliteLifecycleError, acquireProcessWriter } from "@opencraft/sqlite-node";
import type { ServerDatabaseSource } from "./repository.js";
import { importServerData } from "./import.js";
import { SERVER_MIGRATIONS, OPENCRAFT_VERSION } from "./migrations.generated.js";
export { SERVER_MIGRATIONS } from "./migrations.generated.js";

export const SERVER_DATA_CONTRACT = Object.freeze({ productVersion: OPENCRAFT_VERSION, store: "server", migrationVersion: SERVER_MIGRATIONS.length,
  hash: createHash("sha256").update(JSON.stringify(SERVER_MIGRATIONS)).digest("hex") });

export type ServerDatabase = Exclude<ServerDatabaseSource, string> & {
  readonly contract: typeof SERVER_DATA_CONTRACT;
  close(): Promise<void>;
};

/** Owns the same installation fence used by Headless, including offline admin commands. */
export async function openServerDatabase(directory: string): Promise<ServerDatabase> {
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
    managed = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS, legacyPolicy: "reject" });
    // Retain installation identity even after a current-core-only backup restoration.
    mkdirSync(join(directory, ".server-import"), { recursive: true, mode: 0o700 });
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const imported = importServerData(managed.database, directory, SERVER_DATA_CONTRACT);
    if (imported === "migrated") managed = { ...managed, outcome: { ...managed.outcome, status: "migrated" } };
    let closed = false;
    return { ...managed, contract: SERVER_DATA_CONTRACT, async close() {
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
