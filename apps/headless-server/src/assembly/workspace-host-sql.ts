// The WorkspaceHost's SQL as one database (workspace-host-split §4.1): every
// store a workspace's Host owns keeps its published migration chain, unchanged,
// as one migration family (`@opencraft/sql/families`, composition `families`,
// ledger `schema_family_migrations`). The Node Host still opens each store as
// its own file with `openManagedDatabase`; a runtime with one database per owner
// (the WorkspaceHost Durable Object) opens them all here. Each chain is the
// owner's published prefix plus the generated SQL the storage registry appends,
// exactly as the Node owner applies it (`resolveSqlMigrationContract` is the
// neutral form of the Node owner's `resolveStoreMigrations`).
//
// Not a family: the thread-identity library (its execution leases are the Host
// state's `immutable-execution-leases`, the same SQL) and the DSH thread catalog
// (the engine's own library in the container; the Host's thread directory is the
// Host state's `durable-thread-catalog`). Both would create objects the Host
// state already has.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { hashSqlMigrations, resolveSqlMigrationContract, type SqlMigration } from "@opencraft/sql/migrations";
import {
  applySqlMigrationFamilies,
  MIGRATION_FAMILY_LEDGER_TABLE,
  type SqlMigrationFamily,
  type SqlMigrationFamilyOutcome,
} from "@opencraft/sql/families";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import { OPENCRAFT_HOST_STATE_MIGRATIONS } from "@opencraft/opencraft-daemon/opencraft-host-state-database";
import { PROVISIONAL_THREAD_MIGRATIONS } from "@opencraft/opencraft-daemon/provisional-threads";
import { CONVERSATION_SCHEDULE_MIGRATIONS } from "@opencraft/host-schedules";
import { INTERRUPTED_TURN_RECOVERY_MIGRATIONS, PROVIDER_TURN_RETRY_MIGRATIONS } from "@opencraft/host-recovery";
import { EMPLOYEE_GIT_VAULT_MIGRATIONS } from "@opencraft/execution-environment/employee-git-vault";
import { WORKSPACE_BRIDGE_INBOX_MIGRATIONS } from "@opencraft/agent-bridge-host/inbox-store";

/** Family ids are the storage registry's schema ids, so a chain is named the same everywhere. */
export const WORKSPACE_HOST_SQL_STORES = [
  ["opencraft-host-state-database", OPENCRAFT_HOST_STATE_MIGRATIONS],
  ["provisional-threads", PROVISIONAL_THREAD_MIGRATIONS],
  ["host-schedules", CONVERSATION_SCHEDULE_MIGRATIONS],
  ["host-recovery", INTERRUPTED_TURN_RECOVERY_MIGRATIONS],
  ["provider-retry", PROVIDER_TURN_RETRY_MIGRATIONS],
  ["employee-git-vault-store", EMPLOYEE_GIT_VAULT_MIGRATIONS],
] as const satisfies readonly (readonly [keyof typeof STORE_MIGRATIONS, readonly SqlMigration[]])[];

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The families in the order they are applied; a published prefix that changed is refused. */
export function workspaceHostSqlFamilies(): readonly SqlMigrationFamily[] {
  const stores = WORKSPACE_HOST_SQL_STORES.map(([id, prefix]) => ({
    id,
    migrations: hashSqlMigrations(resolveSqlMigrationContract(prefix, STORE_MIGRATIONS[id], sha256Hex), sha256Hex),
  }));
  return [...stores, { id: "workspace-bridge-inbox", migrations: hashSqlMigrations(WORKSPACE_BRIDGE_INBOX_MIGRATIONS, sha256Hex) }];
}

/** Migrates the WorkspaceHost's one database; refuses a foreign, changed or newer history. */
export function migrateWorkspaceHostSql(
  database: SqlDatabase,
  options: { readonly ownedByRuntime?: (name: string) => boolean } = {},
): readonly SqlMigrationFamilyOutcome[] {
  return applySqlMigrationFamilies(database, workspaceHostSqlFamilies(), {
    table: MIGRATION_FAMILY_LEDGER_TABLE,
    composition: "families",
    ...options,
  });
}
