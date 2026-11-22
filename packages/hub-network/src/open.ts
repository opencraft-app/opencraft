import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import { HubNetwork } from "./node.js";
import { MemoryHubStore, type State } from "./store.js";

export type HubNetworkOptions = Omit<NonNullable<ConstructorParameters<typeof HubNetwork>[1]>, "persist">;

/**
 * A Hub for a network process. A Worker owns the state file and its writer
 * lock; the Hub keeps its state in memory and acknowledges each change only
 * after the Worker wrote it (durable mode).
 */
export async function openHubNetwork(
  path: string,
  options: HubNetworkOptions = {},
): Promise<{ node: HubNetwork; close(): Promise<void> }> {
  const { owner, ready } = await WorkerOwner.open<{ save(state: State): void }, { state: State }>(
    ownerEntry(import.meta.url, "hub-state"),
    { name: "Hub state", workerData: { path } },
  );
  let node: HubNetwork | undefined;
  try {
    const revision = ready.state.revision;
    node = new HubNetwork(new MemoryHubStore(ready.state), {
      ...options,
      persist: (state) => owner.call.save(state as State),
    });
    // Configuring the identity authority at open is itself a change to persist.
    if (node.store.state.revision !== revision) await owner.call.save(structuredClone(node.store.state));
  } catch (error) {
    node?.close();
    await owner.close();
    throw error;
  }
  const opened = node;
  let closing: Promise<void> | undefined;
  return {
    node: opened,
    close: () =>
      (closing ??= (async () => {
        try {
          opened.close();
        } finally {
          await owner.close();
        }
      })()),
  };
}
