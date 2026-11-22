import { SqliteLifecycleError, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import { borrowServerDatabase } from "./borrow.js";
import type { ServerDatabase } from "./index.js";
import { installedServerMigrationComposition, type ServerDataContract } from "./migration-composition.js";

/**
 * Opens the Server installation for a network process. A Worker acquires the
 * writer lock and runs migrations and the legacy import, then keeps the lock
 * for the process lifetime. This thread joins the migrated database with its
 * own WAL connection for the domains that still run here
 * (docs/architecture/server/server-core-owner.md, stage 1).
 */
export async function openServerCoreOwner(directory: string): Promise<ServerDatabase> {
  const { owner, ready } = await WorkerOwner.open<object, { outcome: DatabaseOutcome; contract: ServerDataContract }>(
    ownerEntry(import.meta.url, "server-core-owner"),
    {
      name: "Server storage",
      workerData: { directory, composition: installedServerMigrationComposition() },
      errors: [SqliteLifecycleError],
    },
  );
  let connection: ReturnType<typeof borrowServerDatabase>;
  try {
    // The owner's connection settings (no foreign key enforcement, 5 s busy wait),
    // so domains on this thread behave exactly as they did on the owner connection.
    connection = borrowServerDatabase(directory, {
      migrationVersion: ready.contract.migrationVersion,
      foreignKeys: false,
      busyTimeoutMs: 5000,
    });
  } catch (error) {
    await owner.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    database: connection.database,
    outcome: ready.outcome,
    contract: ready.contract,
    close: () =>
      (closing ??= (async () => {
        try {
          connection.close();
        } finally {
          await owner.close();
        }
      })()),
  };
}
