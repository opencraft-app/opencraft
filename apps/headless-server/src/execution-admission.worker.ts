import { parentPort, workerData } from "node:worker_threads";
import { GitExecutionAuthority, resolveExecutionAdmission } from "./git-execution-authority.js";

/** Read-only durable admission for an execution owner process. Lease and Actor
 * SQLite reads stay in this Worker, never on the owner's event loop. */
const authority = new GitExecutionAuthority((workerData as { directory: string }).directory, "actor");
parentPort!.on("message", (message: { type?: string; id?: number; locator?: unknown }) => {
  if (message?.type === "close") {
    authority.close();
    parentPort!.close();
    return;
  }
  if (!Number.isSafeInteger(message?.id)) return;
  try {
    // A locator never names a Project; the vault owner resolves it.
    const value = resolveExecutionAdmission(authority, { ...(message.locator as object), projectId: null });
    parentPort!.postMessage({ id: message.id, value });
  } catch {
    parentPort!.postMessage({ id: message.id, error: true });
  }
});
