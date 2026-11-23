import {
  SecretStoreCorruptError,
  validateKeyName,
  type KeyMaterial,
  type SecretStore,
} from "@opencraft/secret-storage";
import { documentSecretStore } from "@opencraft/secret-storage/documents";
import type { DurableObjectStorage } from "./bindings.js";
import { durableObjectStateDocumentStore } from "./state.js";

/**
 * Named secrets as one `credentials.json` state document in the owner Durable
 * Object, in its own KV namespace. Values are stored as Durable Object data
 * (encrypted at rest by the platform) but not yet sealed with a key from a
 * Secrets binding; that envelope encryption is a later deployment step.
 */
export function durableObjectSecretStore(storage: DurableObjectStorage): SecretStore {
  return documentSecretStore(durableObjectStateDocumentStore(storage, { prefix: "secret/" }));
}

/**
 * Installation keys in the owner Durable Object's synchronous KV storage.
 * `ensure` checks and creates inside one `transactionSync`, so concurrent
 * creators converge on the first key. The same encryption note as
 * `durableObjectSecretStore` applies.
 */
export function durableObjectKeyMaterial(storage: DurableObjectStorage): KeyMaterial {
  const load = (name: string): Uint8Array | undefined => {
    const stored = storage.kv.get(`key/${name}`);
    if (stored === undefined) return undefined;
    if (!(stored instanceof Uint8Array) || !stored.byteLength) throw new SecretStoreCorruptError();
    return new Uint8Array(stored);
  };
  return {
    async read(name) {
      validateKeyName(name);
      return load(name);
    },
    async ensure(name, create) {
      validateKeyName(name);
      const key = storage.transactionSync(() => {
        const existing = load(name);
        if (existing) return existing;
        const fresh = create();
        if (!(fresh instanceof Uint8Array) || !fresh.byteLength)
          throw new TypeError("Key material must be non-empty bytes");
        const copy = new Uint8Array(fresh);
        storage.kv.put(`key/${name}`, copy);
        return new Uint8Array(copy);
      });
      // A converging caller may observe a key another call wrote but has not yet confirmed.
      await storage.sync();
      return key;
    },
  };
}
