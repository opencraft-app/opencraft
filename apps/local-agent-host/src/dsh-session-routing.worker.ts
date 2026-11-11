import { parentPort, workerData } from "node:worker_threads";
import { DshRoutingRejection } from "./dsh-routing-projection.js";
import { DshSessionRouting } from "./dsh-session-routing.js";
if (!parentPort) throw new Error("DSH routing storage requires a Worker");
const port = parentPort;
const routing = new DshSessionRouting(workerData.path);
// Each operation is synchronous only in this Worker. No transaction spans a
// native RPC, and ordered message delivery preserves commit/ACK dependencies.
port.on("message", ({ id, method, args }) => {
  try {
    if (!Array.isArray(args) || !["snapshot", "stage", "publish", "reconcile", "close"].includes(method)) throw new Error("Unsupported DSH routing operation");
    if (method === "close") { routing.close(); port.postMessage({ id }); port.close(); return; }
    const result = method === "snapshot" ? undefined : Reflect.apply(routing[method as "stage" | "publish" | "reconcile"], routing, args);
    port.postMessage({ id, result, snapshot: routing.snapshot(), outcome: routing.outcome });
  } catch (error) {
    if (error instanceof DshRoutingRejection) {
      try {
        // Domain guards either ran before SQL or their transaction rolled back.
        // Return the confirmed old authority and keep the owner available.
        port.postMessage({ id, error: { message: error.message, code: error.code, recoverable: true },
          snapshot: routing.snapshot(), outcome: routing.outcome });
        return;
      } catch (storageError) { error = storageError; }
    }
    const value = error as Error & { kind?: string };
    // Release the process-owned writer lease before acknowledging failure. A
    // raw terminate would strand a live-PID lease and cannot authorize recovery.
    try { routing.close(); } catch { /* Retain the original operation failure. */ }
    port.postMessage({ id, error: { message: value.message, kind: value.kind } });
    port.close();
  }
});
