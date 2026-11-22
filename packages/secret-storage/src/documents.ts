import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { SecretStoreCorruptError, validateSecretName, validateSecretValue, type SecretStore } from "./contract.js";

type SecretDocument = { schemaVersion: 1; entries: Record<string, string> };

function parse(value: unknown): SecretDocument {
  if (value === null) return { schemaVersion: 1, entries: {} };
  const doc = value as { schemaVersion?: unknown; entries?: unknown };
  if (doc.schemaVersion !== 1 || !doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries)
    || Object.values(doc.entries).some((entry) => typeof entry !== "string")) {
    throw new SecretStoreCorruptError();
  }
  return { schemaVersion: 1, entries: { ...(doc.entries as Record<string, string>) } };
}

// Stamps are keyed per process (per isolate in workerd) so a stamp never
// becomes an offline oracle for the secrets it covers; they are comparable only
// within one process. The key is created on first use because workerd forbids
// generating random values in global scope.
let stampKey: Promise<CryptoKey> | undefined;
const stampingKey = () => (stampKey ??= crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]) as Promise<CryptoKey>);

/**
 * Secrets as one `{schemaVersion: 1, entries}` state document (the existing
 * `credentials.json` layout). With `fileStateDocumentStore` the file is
 * private (0600), written atomically and serialized across processes.
 */
export function documentSecretStore(documents: StateDocumentStore, key = "credentials.json"): SecretStore {
  return {
    async get(name) {
      validateSecretName(name);
      const entries = parse(await documents.read(key)).entries;
      return Object.hasOwn(entries, name) ? entries[name] : undefined;
    },
    async set(name, value) {
      validateSecretName(name);
      validateSecretValue(value);
      await documents.update(key, (current) => {
        const doc = parse(current);
        return { result: undefined, next: { schemaVersion: 1, entries: { ...doc.entries, [name]: value } } };
      });
    },
    async delete(name) {
      validateSecretName(name);
      await documents.update(key, (current) => {
        const doc = parse(current);
        if (!Object.hasOwn(doc.entries, name)) return { result: undefined };
        delete doc.entries[name];
        return { result: undefined, next: doc };
      });
    },
    async stamp() {
      const value = await documents.read(key);
      if (value === null) return "absent";
      const digest = await crypto.subtle.sign("HMAC", await stampingKey(), new TextEncoder().encode(JSON.stringify(parse(value).entries)));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}

