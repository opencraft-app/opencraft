import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import { TerminalCapacityError } from "./process-identity.js";
import type { TerminalAdmissionStore } from "./terminal-admission-store.js";
/** One subordinate storage owner, not another quota ledger. The permanent
 * kernel writer lock lives in this Worker; a paused Hands process cannot expire
 * and be replaced by a second writer. No synchronous store IO in the IPC loop. */
export async function openTerminalAdmission(directory: string) {
  const { owner } = await WorkerOwner.open<
    Pick<
      TerminalAdmissionStore,
      "probe" | "reserve" | "release" | "destroyRemoteResource" | "held" | "launch" | "abandon"
    >
  >(ownerEntry(import.meta.url, "terminal-admission"), {
    name: "Hands terminal admission",
    workerData: { directory },
    errors: [TerminalCapacityError],
    maxPending: 256,
  });
  return {
    probe: owner.call.probe,
    reserve: owner.call.reserve,
    release: owner.call.release,
    destroyRemoteResource: owner.call.destroyRemoteResource,
    held: owner.call.held,
    launch: owner.call.launch,
    abandon: owner.call.abandon,
    close: () => owner.close(),
  };
}
