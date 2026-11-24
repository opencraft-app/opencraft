import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { documentHubStore, HUB_STATE_DOCUMENT } from "./document-hub-store.js";
import { parseHubControllerConfiguration, type HubStatePort } from "./state-port.js";

/**
 * The Hub state port over a StateDocumentStore whose owner is the single
 * writer (for example a single-writer object's own storage). The node state is
 * the same document the Node owner keeps as `hub-network.json`; a remote
 * controller configuration, when the deployment has one, is supplied as the
 * value the operator installed and validated like the Node file.
 */
export function documentHubStatePort(
  documents: StateDocumentStore,
  options: { readonly controller?: unknown; readonly key?: string } = {},
): HubStatePort {
  const key = options.key ?? HUB_STATE_DOCUMENT;
  return {
    async readController() {
      return options.controller === undefined || options.controller === null
        ? null
        : parseHubControllerConfiguration(options.controller);
    },
    async openNode() {
      const hubState = documentHubStore(documents, key);
      const state = await hubState.open();
      let pending = Promise.resolve();
      let closed = false;
      return {
        state,
        save(next) {
          if (closed) return Promise.reject(new Error("Hub store is closed"));
          const saved = pending.then(() => hubState.save(next));
          pending = saved.catch(() => undefined);
          return saved;
        },
        async close() {
          closed = true;
          await pending;
        },
      };
    },
  };
}
