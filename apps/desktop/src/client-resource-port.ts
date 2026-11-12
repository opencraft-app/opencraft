import { resourceKey, validateResourceRecord, type ClientResourceKey, type ClientResourceRecord } from "@opencraft/document-storage/client-resources";
import type { SqliteClientResources } from "@opencraft/document-storage/client-resources-sqlite";

/** Only implemented resource owners receive a desktop storage port. This is a
 * display partition supplied by the trusted renderer, never verified account authority. */
export function createDesktopClientResourcePort(store: () => Pick<SqliteClientResources, "read" | "compareAndSet" | "clearRemoteResource" | "listLocalKeys" | "clearLocalResource">) {
  const localNames = new Set(["conversation-draft", "composer-draft", "conversation-outbox"]);
  function key(input: unknown): ClientResourceKey {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid client resource identity");
    const value = input as Record<string, unknown>;
    if (!(value.name === "thread-catalog" && value.authority === "remote")
      && !(typeof value.name === "string" && localNames.has(value.name) && value.authority === "local")) throw new TypeError("Unsupported desktop client resource");
    const result = { namespace: value.namespace, id: value.id, name: value.name, authority: value.authority } as ClientResourceKey;
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
      validateResourceRecord(record, revision, identity.authority);
      if (record.version !== (identity.authority === "remote" ? 2 : 1)
        || (identity.authority === "local" && record.value !== null && typeof record.value !== "string")) throw new TypeError("Unsupported desktop client resource version");
      return store().compareAndSet(identity, revision, record);
    },
    clearRemoteNamespace(namespace: unknown) {
      const identity = key({ namespace, name: "thread-catalog", id: "namespace", authority: "remote" });
      return store().clearRemoteResource(identity.namespace, identity.name);
    },
    listLocalKeys(namespace: unknown, name: unknown) {
      const identity = key({ namespace, name, id: "namespace", authority: "local" });
      return store().listLocalKeys(identity.namespace, identity.name);
    },
    clearLocalResource(namespace: unknown, name: unknown) {
      const identity = key({ namespace, name, id: "namespace", authority: "local" });
      return store().clearLocalResource(identity.namespace, identity.name);
    },
  };
}
