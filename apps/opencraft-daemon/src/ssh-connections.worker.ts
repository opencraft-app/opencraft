import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { SshConnectionStore, type SshConnectionInput } from "./ssh-connection-store.js";

/** Owns the SSH connection database, its credential key and the known_hosts projections. */
serveWorkerOwner(({ directory }: { directory: string }) => {
  const store = new SshConnectionStore(directory);
  try {
    const records = store.list();
    for (const record of records) store.writeKnownHosts(record.serverId);
    return {
      ready: { outcome: store.outcome, records },
      methods: {
        save: (serverId: string | null, revision: number, input: SshConnectionInput, trustedHostKey?: string) => {
          const record = store.save(serverId, revision, input, trustedHostKey);
          store.writeKnownHosts(record.serverId);
          return record;
        },
        remove: (serverId: string, revision: number) => store.remove(serverId, revision),
        password: (serverId: string, revision: number) => store.password(serverId, revision),
      },
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
});
