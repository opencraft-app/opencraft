import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { readOfflineMemory } from "./memory-browser-offline.mjs";

// Offline memory browsing for a Host whose assistant process is stopped: the
// SQLite snapshot, memory files and root lock are read here, off the Host's event loop.
serveWorkerOwner(() => ({
  methods: { read: (directory, binding, raw) => readOfflineMemory(directory, binding, raw) },
}));
