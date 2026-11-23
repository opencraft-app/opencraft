import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { HubStateFile } from "./store-file.js";

/** Owns the Hub's private state file and its process writer lock. */
serveWorkerOwner(async ({ path }: { path: string }) => {
  const file = await HubStateFile.open(path);
  return {
    ready: { state: file.state },
    methods: { save: (state: unknown) => file.save(state) },
    close: () => file.close(),
  };
});
