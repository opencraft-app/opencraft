import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { installServerMigrationComposition, openServerDatabase } from "./index.js";
import type { ServerMigrationComposition } from "./migration-composition.js";

/**
 * Owns the Server installation: the process writer lock, migrations and the
 * legacy import run here, off the network thread, and the lock is held until
 * the owner closes.
 */
serveWorkerOwner(
  async ({ directory, composition }: { directory: string; composition?: ServerMigrationComposition }) => {
    // Trusted parent-owned data only, as for the server-spaces Worker.
    if (composition !== undefined) installServerMigrationComposition(composition);
    const owner = await openServerDatabase(directory);
    return {
      ready: { outcome: owner.outcome, contract: owner.contract },
      methods: {},
      close: () => owner.close(),
    };
  },
);
