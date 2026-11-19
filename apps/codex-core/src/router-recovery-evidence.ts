import {Worker} from "node:worker_threads";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

/** One-shot startup reader; SQLite inspection and lock waits stay off the RPC loop. */
export async function readRouterRecoveryEvidence(directory: string): Promise<readonly {key: string; value: unknown}[]> {
  const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const worker = new Worker(join(dirname(ownFile), "router-evidence-worker.mjs"), {workerData: {directory}, execArgv: []});
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Router responsibility reader exited before acknowledgement")));
    });
  } finally {await worker.terminate();}
}
