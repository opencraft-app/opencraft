import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { HubStore } from "./store-file.js";

/** Owns the Hub's private state file and its process writer lock. */
serveWorkerOwner(({ path }: { path: string }) => {
  const store = new HubStore(path);
  return {
    ready: { state: store.state },
    methods: { save: (state: unknown) => store.replace(state) },
    close: () => store.close(),
  };
});
