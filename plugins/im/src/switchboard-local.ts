import type { OwnerCalls } from "@opencraft/worker-owner";
import type { SwitchboardStore } from "./store.js";
import { SwitchboardOwner } from "./switchboard-owner.js";
import { Switchboard } from "./switchboard.js";

/**
 * A switchboard over a store this thread already owns, for tests and offline
 * tools. Calls still resolve asynchronously, as they do through the Worker.
 */
export function localSwitchboard(store: SwitchboardStore): Switchboard {
  const owner = new SwitchboardOwner(store);
  const port = new Proxy({} as OwnerCalls<SwitchboardOwner>, {
    get: (_target, method) =>
      typeof method === "string" && method !== "then"
        ? async (...args: unknown[]) =>
            structuredClone((owner as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args))
        : undefined,
  });
  return new Switchboard(port, structuredClone(owner.snapshot()), async () => owner.close());
}
