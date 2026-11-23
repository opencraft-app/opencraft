import { SqliteLifecycleError, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { WorkerOwner, ownerEntry, type OwnerCalls } from "@opencraft/worker-owner";
import { borrowServerDatabase } from "./borrow.js";
import type { ServerDatabase } from "./index.js";
import { installedServerMigrationComposition, type ServerDataContract } from "./migration-composition.js";

import type { CreationReceiptMethods } from "./conversation-creation-receipts.js";
import type { ConversationResourceMethods } from "./conversation-resources.js";
export type { CreationReceipt, CreationReceiptMethods } from "./conversation-creation-receipts.js";
export type { ConversationResourceMethods, ConversationResourceRow } from "./conversation-resources.js";

type CoreMethods = CreationReceiptMethods & ConversationResourceMethods;

/** The Server installation as a network process holds it. */
export interface ServerCoreStorage<T = object> extends ServerDatabase {
  /** Async ports of the domain services that run in the owner Worker. */
  readonly call: OwnerCalls<T & CoreMethods>;
  /**
   * Reports, once, that the owner Worker was lost (crash, exit or a fatal
   * error). Every pending and later call already rejects; projections built
   * from owner replies use this to fail closed before their next call.
   */
  onUnavailable(listener: (error: Error) => void): () => void;
}

/**
 * Opens the Server installation for a network process. A Worker acquires the
 * writer lock and runs migrations and the legacy import, then keeps the lock
 * for the process lifetime and serves the domains its `entry` builds
 * (`serveServerCoreOwner`). This thread joins the migrated database with its
 * own WAL connection for the domains that still run here
 * (docs/architecture/server/server-core-owner.md).
 */
export async function openServerCoreOwner<T = object>(
  directory: string,
  {
    entry = ownerEntry(import.meta.url, "server-core-owner"),
    data,
  }: {
    entry?: URL;
    /** Passed to the entry's domains, e.g. a SharedArrayBuffer for a commit fence. */
    data?: Record<string, unknown>;
  } = {},
): Promise<ServerCoreStorage<T>> {
  const unavailable = new Set<(error: Error) => void>();
  let lost: Error | undefined;
  const { owner, ready } = await WorkerOwner.open<
    T & CoreMethods,
    { outcome: DatabaseOutcome; contract: ServerDataContract }
  >(entry, {
    name: "Server storage",
    workerData: { directory, composition: installedServerMigrationComposition(), data },
    errors: [SqliteLifecycleError],
    onFailure: (error) => {
      lost = error;
      for (const listener of [...unavailable]) {
        try {
          listener(error);
        } catch {
          // A listener only revokes its own projection; others still run.
        }
      }
    },
  });
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
    call: owner.call,
    onUnavailable: (listener) => {
      if (lost) {
        listener(lost);
        return () => {};
      }
      unavailable.add(listener);
      return () => unavailable.delete(listener);
    },
    database: connection.database,
    location: connection.location,
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
