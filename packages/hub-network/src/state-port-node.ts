import { lstat } from "node:fs/promises";
import { readPrivateJson } from "@opencraft/identity-core/node";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import { parseHubControllerConfiguration, type HubNodeStateOwner, type HubStatePort } from "./state-port.js";
import type { State } from "./store.js";

/**
 * The Hub node's state file in a Worker that owns it and its writer lock
 * (`HubStateFile`: `<path>.lock`, private document, atomic replace), so the
 * network thread never touches the file or blocks on the lock. A save resolves
 * after the Worker wrote it.
 */
export async function openHubStateWorker(path: string): Promise<HubNodeStateOwner> {
  const { owner, ready } = await WorkerOwner.open<{ save(state: State): void }, { state: State }>(
    ownerEntry(import.meta.url, "hub-state"),
    { name: "Hub state", workerData: { path } },
  );
  return {
    state: ready.state,
    save: (state) => owner.call.save(state),
    close: () => owner.close(),
  };
}

/**
 * Node adapter of the Hub state port over the deployment's two private files:
 * the operator's `controllerFile` (owner-only, read when it exists) and the
 * node's `stateFile`, owned by the Hub state Worker.
 */
export function nodeHubStatePort({
  controllerFile,
  stateFile,
}: {
  controllerFile: string;
  stateFile: string;
}): HubStatePort {
  return {
    async readController() {
      try {
        await lstat(controllerFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return parseHubControllerConfiguration(await readPrivateJson(controllerFile));
    },
    openNode: () => openHubStateWorker(stateFile),
  };
}
