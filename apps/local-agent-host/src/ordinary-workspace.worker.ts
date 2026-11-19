import { parentPort, workerData } from "node:worker_threads";
import { OrdinaryWorkspaceJournal } from "./ordinary-workspace-journal.js";
const methods = new Set([
  "admit",
  "admitResolved",
  "resolvedSelection",
  "attachThread",
  "beginThreadStart",
  "confirmThreadStarted",
  "pendingThreadStarts",
  "read",
  "forThread",
  "hasThread",
  "beginCreate",
  "cancelUnsubmittedCreate",
  "recordProviderReceipt",
  "confirmCreated",
  "beginRelease",
  "markUncertain",
  "confirmComputeAbsent",
  "pendingForHost",
]);
const journal = new OrdinaryWorkspaceJournal(workerData.directory, workerData.deploymentId);
parentPort!.postMessage({ ready: true, outcome: journal.outcome });
parentPort!.on("message", (message: { id: number; method: string; args: unknown[] }) => {
  try {
    if (message.method === "close") {
      journal.close();
      parentPort!.postMessage({ id: message.id });
      parentPort!.close();
      return;
    }
    if (!methods.has(message.method)) throw Error("Unknown workspace journal operation");
    const method = (journal as unknown as Record<string, (...args: unknown[]) => unknown>)[message.method]!;
    parentPort!.postMessage({ id: message.id, value: method.apply(journal, message.args) });
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : "Workspace journal operation failed",
    });
  }
});
