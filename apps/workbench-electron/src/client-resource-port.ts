import { resourceKey, validateResourceRecord, type ClientResourceKey, type ClientResourceRecord } from "@opencraft/document-storage/client-resources";
import type { SqliteClientResources } from "@opencraft/document-storage/client-resources-sqlite";

/** Only implemented resource owners receive a desktop storage port. This is a
 * display partition supplied by the trusted renderer, never verified account authority. */
export function createDesktopClientResourcePort(store: () => Pick<SqliteClientResources, "read" | "compareAndSet" | "clearRemoteResource">) {
  function key(input: unknown): ClientResourceKey {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid client resource identity");
    const value = input as Record<string, unknown>;
    if (value.name !== "thread-catalog" || value.authority !== "remote") throw new TypeError("Unsupported desktop client resource");
    const result = { namespace: value.namespace, id: value.id, name: "thread-catalog", authority: "remote" } as ClientResourceKey;
    resourceKey(result);
    return result;
  }
  return {
    read(input: unknown) {
      const identity = key(input);
      return store().read(identity);
    },
    compareAndSet(input: unknown, revision: unknown, inputRecord: unknown) {
      const identity = key(input);
      if (typeof revision !== "number" || !inputRecord || typeof inputRecord !== "object" || Array.isArray(inputRecord)) throw new TypeError("Invalid client resource record");
      const record = inputRecord as Omit<ClientResourceRecord, "revision">;
      validateResourceRecord(record, revision);
      if (record.version !== 2) throw new TypeError("Unsupported desktop client resource version");
      return store().compareAndSet(identity, revision, record);
    },
    clearRemoteNamespace(namespace: unknown) {
      const identity = key({ namespace, name: "thread-catalog", id: "namespace", authority: "remote" });
      return store().clearRemoteResource(identity.namespace, identity.name);
    },
  };
}
