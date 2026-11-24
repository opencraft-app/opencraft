// The WorkspaceHost's SQL as one database (workspace-host-split §4.1): every
// store a workspace's Host owns keeps its published migration chain, unchanged,
// as one family of the shared ledger (`@opencraft/sql/families`). The Node
// Host still opens each store as its own file with `openManagedDatabase`; a
// runtime with one database per owner (the WorkspaceHost Durable Object) opens
// them all here. Each chain is the owner's published prefix plus the generated
// SQL the storage registry appends, exactly as the Node owner applies it.
//
// Not a family: the thread-identity library (its execution leases are the Host
// state's `immutable-execution-leases`, the same SQL) and the DSH thread catalog
// (the engine's own library in the container; the Host's thread directory is the
// Host state's `durable-thread-catalog`). Both would create objects the Host
// state already has.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";
import {
  applySqlMigrationFamilies,
  type SqlMigrationFamily,
  type SqlMigrationFamilyOptions,
  type SqlMigrationFamilyOutcome,
} from "@opencraft/sql/families";
import { resolveStoreMigrations, type StorageSchemaId } from "@opencraft/sqlite-node";
import { OPENCRAFT_HOST_STATE_MIGRATIONS } from "@opencraft/opencraft-daemon/opencraft-host-state-database";
import { PROVISIONAL_THREAD_MIGRATIONS } from "@opencraft/opencraft-daemon/provisional-threads";
import { CONVERSATION_SCHEDULE_MIGRATIONS } from "@opencraft/host-schedules";
import { INTERRUPTED_TURN_RECOVERY_MIGRATIONS, PROVIDER_TURN_RETRY_MIGRATIONS } from "@opencraft/host-recovery";
import { EMPLOYEE_GIT_VAULT_MIGRATIONS } from "@opencraft/execution-environment/employee-git-vault";

/** Family ids are the storage registry's schema ids, so a chain is named the same everywhere. */
export const WORKSPACE_HOST_SQL_STORES = [
  ["opencraft-host-state-database", OPENCRAFT_HOST_STATE_MIGRATIONS],
  ["provisional-threads", PROVISIONAL_THREAD_MIGRATIONS],
  ["host-schedules", CONVERSATION_SCHEDULE_MIGRATIONS],
  ["host-recovery", INTERRUPTED_TURN_RECOVERY_MIGRATIONS],
  ["provider-retry", PROVIDER_TURN_RETRY_MIGRATIONS],
  ["employee-git-vault-store", EMPLOYEE_GIT_VAULT_MIGRATIONS],
] as const satisfies readonly (readonly [StorageSchemaId, readonly SqlMigration[]])[];

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The families in the order they are applied; the registry refuses a published prefix that changed. */
export function workspaceHostSqlFamilies(): readonly SqlMigrationFamily[] {
  return WORKSPACE_HOST_SQL_STORES.map(([id, prefix]) => ({
    id,
    migrations: hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex),
  }));
}

/** Migrates the WorkspaceHost's one database; refuses a foreign, changed or newer history. */
export function migrateWorkspaceHostSql(
  database: SqlDatabase,
  options?: SqlMigrationFamilyOptions,
): readonly SqlMigrationFamilyOutcome[] {
  return applySqlMigrationFamilies(database, workspaceHostSqlFamilies(), options);
}
