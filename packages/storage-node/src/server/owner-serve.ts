import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { installServerMigrationComposition, openServerDatabase, type ServerDatabase } from "./index.js";
import { conversationResourceLegacyJournal } from "./conversation-resource-journal.js";
import { serverCoreStorageMethods } from "./core-methods.js";
import type { ServerMigrationComposition } from "./migration-composition.js";

/** Domain services that run beside the Server owner, on its connection. */
export interface ServerCoreDomains {
  /** Async ports the network thread calls; each runs in this Worker in FIFO order. */
  readonly methods: Record<string, (...args: never[]) => unknown>;
  /** Releases domain resources before the owner connection and writer lock. */
  close?(): void | Promise<void>;
}

/**
 * Runs inside a Server owner Worker. The process writer lock, migrations and
 * the legacy import run here, off the network thread, and the lock is held
 * until the owner closes. `domains` builds the domain services this Worker
 * serves on the owner connection (docs/architecture/server/server-core-owner.md).
 */
export function serveServerCoreOwner(
  domains?: (owner: ServerDatabase, data: Record<string, unknown>) => ServerCoreDomains,
): void {
  serveWorkerOwner(
    async ({
      directory,
      composition,
      data,
    }: {
      directory: string;
      composition?: ServerMigrationComposition;
      /** Parent-supplied values for the domains, such as a commit fence buffer. */
      data?: Record<string, unknown>;
    }) => {
      // Trusted parent-owned data only, as for the server-spaces Worker.
      if (composition !== undefined) installServerMigrationComposition(composition);
      const owner = await openServerDatabase(directory);
      let served: ServerCoreDomains;
      let storage: ReturnType<typeof serverCoreStorageMethods>;
      try {
        // The retired journal lives beside the database; it is imported when the
        // lifecycle opens, not here, because only the lifecycle knows its owners.
        storage = serverCoreStorageMethods(owner.database, conversationResourceLegacyJournal(directory));
        served = domains?.(owner, data ?? {}) ?? { methods: {} };
      } catch (error) {
        await owner.close();
        throw error;
      }
      return {
        ready: { outcome: owner.outcome, contract: owner.contract },
        methods: { ...served.methods, ...storage },
        close: async () => {
          try {
            await served.close?.();
          } finally {
            await owner.close();
          }
        },
      };
    },
  );
}
