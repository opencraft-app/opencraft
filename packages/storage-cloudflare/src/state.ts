import {
  StateDocumentCorruptError,
  stateChangeOutcome,
  validateStateKey,
  type StateDocumentStore,
} from "@opencraft/document-storage/state";
import type { DurableObjectStorage } from "./bindings.js";

export interface DurableObjectStateOptions {
  /** Namespace inside the Durable Object's KV storage; distinct stores must not share one. */
  readonly prefix?: string;
}

/**
 * State documents in a SQLite-backed Durable Object's synchronous KV storage.
 * Each document is stored as its JSON text. `update` reads, applies the change
 * and writes inside one `transactionSync`, so it is atomic and serialized by
 * the object's single thread; it resolves after `storage.sync()` confirms
 * that write, and any write the change observed, is durable.
 */
export function durableObjectStateDocumentStore(
  storage: DurableObjectStorage,
  options: DurableObjectStateOptions = {},
): StateDocumentStore {
  const prefix = options.prefix ?? "state/";
  const load = (key: string): unknown | null => {
    const stored = storage.kv.get(prefix + key);
    if (stored === undefined) return null;
    if (typeof stored !== "string") throw new StateDocumentCorruptError(key);
    try {
      return JSON.parse(stored);
    } catch {
      throw new StateDocumentCorruptError(key);
    }
  };
  return {
    async read(key) {
      validateStateKey(key);
      return load(key);
    },
    async update(key, change) {
      validateStateKey(key);
      const result = storage.transactionSync(() => {
        const outcome = stateChangeOutcome(change(load(key)));
        if (outcome.json !== undefined) storage.kv.put(prefix + key, outcome.json);
        return outcome.result;
      });
      // Also when unchanged: the change may have observed a write that is not yet durable.
      await storage.sync();
      return result;
    },
  };
}
