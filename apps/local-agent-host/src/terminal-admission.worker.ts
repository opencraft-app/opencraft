import { join } from "node:path";
import { acquireProcessWriter } from "@opencraft/sqlite-node";
import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { TerminalAdmissionStore } from "./terminal-admission-store.js";
serveWorkerOwner<{ directory: string }>(async ({ directory }) => {
  const release = acquireProcessWriter(join(directory, "terminal-admission-writer.lock"));
  let store: TerminalAdmissionStore;
  try {
    store = await TerminalAdmissionStore.open(directory);
  } catch (error) {
    release();
    throw error;
  }
  return {
    methods: {
      probe: store.probe.bind(store),
      reserve: store.reserve.bind(store),
      release: store.release.bind(store),
      destroyRemoteResource: store.destroyRemoteResource.bind(store),
    } as never,
    async close() {
      await store.close();
      release();
    },
  };
});
