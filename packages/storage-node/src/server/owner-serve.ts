import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { installServerMigrationComposition, openServerDatabase, type ServerDatabase } from "./index.js";
import { conversationCreationReceiptMethods } from "./conversation-creation-receipts.js";
import { conversationResourceMethods } from "./conversation-resources.js";
import { conversationResourceLegacyJournal } from "./conversation-resource-journal.js";
import { accountModelDefaultsMethods } from "./account-model-defaults.js";
import { environmentCreationReservationMethods } from "./environment-creation-reservations.js";
import { actorSshKeyMethods } from "./actor-ssh-keys.js";
import { threadReadReceiptMethods } from "./thread-read-receipts.js";
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
      let creation: ReturnType<typeof conversationCreationReceiptMethods>;
      let resources: ReturnType<typeof conversationResourceMethods>;
      let modelDefaults: ReturnType<typeof accountModelDefaultsMethods>;
      let reservations: ReturnType<typeof environmentCreationReservationMethods>;
      let sshKeys: ReturnType<typeof actorSshKeyMethods>;
      let readReceipts: ReturnType<typeof threadReadReceiptMethods>;
      try {
        creation = conversationCreationReceiptMethods(owner.database);
        // The retired journal lives beside the database; it is imported when the
        // lifecycle opens, not here, because only the lifecycle knows its owners.
        resources = conversationResourceMethods(owner.database, conversationResourceLegacyJournal(directory));
        modelDefaults = accountModelDefaultsMethods(owner.database);
        reservations = environmentCreationReservationMethods(owner.database);
        sshKeys = actorSshKeyMethods(owner.database);
        readReceipts = threadReadReceiptMethods(owner.database);
        served = domains?.(owner, data ?? {}) ?? { methods: {} };
      } catch (error) {
        await owner.close();
        throw error;
      }
      return {
        ready: { outcome: owner.outcome, contract: owner.contract },
        methods: { ...served.methods, ...creation, ...resources, ...modelDefaults, ...reservations, ...sshKeys, ...readReceipts },
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
