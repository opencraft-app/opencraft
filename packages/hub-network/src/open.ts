import { HubNetwork } from "./node.js";
import { MemoryHubStore, type State } from "./store.js";
import type { HubNodeStateOwner } from "./state-port.js";
import { openHubStateWorker } from "./state-port-node.js";

export type HubNetworkOptions = Omit<NonNullable<ConstructorParameters<typeof HubNetwork>[1]>, "persist">;

/**
 * A Hub over its state port's single writer. The Hub keeps its state in
 * memory and acknowledges each change only after the writer saved it (durable
 * mode); closing the Hub releases the writer.
 */
export async function openHubNode(
  owner: HubNodeStateOwner,
  options: HubNetworkOptions = {},
): Promise<{ node: HubNetwork; close(): Promise<void> }> {
  let node: HubNetwork | undefined;
  try {
    const revision = owner.state.revision;
    node = new HubNetwork(new MemoryHubStore(owner.state), {
      ...options,
      persist: (state) => owner.save(state as State),
    });
    // Configuring the identity authority at open is itself a change to persist.
    if (node.store.state.revision !== revision) await owner.save(structuredClone(node.store.state));
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

/**
 * A Hub for a network process. A Worker owns the state file and its writer
 * lock; the Hub keeps its state in memory and acknowledges each change only
 * after the Worker wrote it (durable mode).
 */
export async function openHubNetwork(
  path: string,
  options: HubNetworkOptions = {},
): Promise<{ node: HubNetwork; close(): Promise<void> }> {
  return openHubNode(await openHubStateWorker(path), options);
}
