import {parentPort, workerData} from "node:worker_threads";
import {inspectGenerationRegistry} from "./generation-registry.js";
// Reuse the registry's read-only, checksummed inspector; never take its writer lease.
const inspected = inspectGenerationRegistry(workerData.directory);
const evidence = Object.entries(inspected.metadata).filter(([key]) => key.startsWith("router-lease:") || key.startsWith("router-uncertainty:"))
  .map(([key, value]) => ({key, value}));
parentPort!.postMessage(evidence); parentPort!.close();
