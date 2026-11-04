import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSchemaValidator, verifyManagedDatabaseHistory, SqliteLifecycleError, type Migration } from "@opencraft/sqlite-node";
import { SERVER_MIGRATIONS } from "./migrations.generated.js";
import { SERVER_READ_COMPATIBILITY as declaration } from "./read-compat.generated.js";

/** Explicit reader opt-in. These chains are never supplied to a writer. */
export function serverIdentityReadContracts() {
  const writer: readonly Migration[] = SERVER_MIGRATIONS;
  const base = writer.slice(0, declaration.baseVersion);
  const target = [...base, declaration.migration];
  const next = [...target, declaration.nextMigration];
  const onceTier = [...next, declaration.onceTierMigration];
  const attachments = [...onceTier, declaration.attachmentMigration];
  const hash = (chain: readonly Migration[]) => createHash("sha256").update(JSON.stringify(chain)).digest("hex");
  const expected = [base,target,next,onceTier,attachments].find(chain=>chain.length===writer.length);
  if(hash(base)!==declaration.baseHash || hash(target)!==declaration.targetHash || hash(next)!==declaration.nextHash || hash(onceTier)!==declaration.onceTierHash || hash(attachments)!==declaration.attachmentHash
    || !expected || hash(writer)!==hash(expected))
    throw new SqliteLifecycleError("history-mismatch", "Server identity reader declaration differs from owner migrations");
  return [base,target,next,onceTier,attachments] as const;
}

/** Caller holds one read transaction through validation and identity queries. */
export function verifyServerIdentityRead(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Server identity validation requires a read transaction");
  const version = database.prepare("SELECT count(*) AS version FROM schema_migrations").get()?.version;
  const chain = serverIdentityReadContracts().find(migrations => migrations.length === version);
  if (!chain) throw new SqliteLifecycleError("history-mismatch", "Unsupported Server identity reader migration boundary");
  verifyManagedDatabaseHistory(database, chain);
  createSchemaValidator(chain.map(migration => migration.sql).join(";\n"))(database);
  if (!database.prepare("SELECT 1 FROM opencraft_server_installation WHERE singleton=1").get()) {
    throw new Error("Server authority migration is incomplete");
  }
}
