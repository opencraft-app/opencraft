import { parentPort, workerData } from "node:worker_threads";
import { environmentLaunchLocator } from "@opencraft/execution-environment/environment-launch-receiver";
import { GitExecutionAuthority, resolveExecutionAdmission } from "./git-execution-authority.js";
import { codexTurnAdmission, creationAdmission } from "./environment-launch-admission.js";

/** Read-only durable admission for an execution owner process. Lease, Actor and
 * creation reservation SQLite reads stay in this Worker, never on the owner's
 * event loop. */
const authority = new GitExecutionAuthority((workerData as { directory: string }).directory, "actor");
/** A v2 record: a pending Codex input or a creation reservation. */
function admission(raw: unknown) {
  const locator = environmentLaunchLocator(raw);
  if (locator.kind === "turn" && locator.hostId === "local-codex")
    return codexTurnAdmission(authority, { hostId: "local-codex", threadId: locator.threadId, inputId: locator.inputId });
  if (locator.kind === "creation") {
    const record = creationAdmission(authority, locator);
    if (!record) throw Error("environment_launch_unavailable");
    return record.admission;
  }
  throw Error("environment_launch_unavailable");
}
parentPort!.on("message", (message: { type?: string; id?: number; locator?: unknown; kind?: string }) => {
  if (message?.type === "close") {
    authority.close();
    parentPort!.close();
    return;
  }
  if (!Number.isSafeInteger(message?.id)) return;
  try {
    // A locator never names a Project; the vault owner resolves it.
    const value =
      message.kind === "v2"
        ? admission(message.locator)
        : resolveExecutionAdmission(authority, { ...(message.locator as object), projectId: null });
    parentPort!.postMessage({ id: message.id, value });
  } catch {
    parentPort!.postMessage({ id: message.id, error: true });
  }
});
