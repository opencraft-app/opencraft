import { traceBrowserStorage } from "./browser-storage-diagnostics";
import { REMOTE_RESOURCE_LIMIT, resourceKey, validateResourceRecord,
  type ClientResourceKey, type ClientResourceRecord, type ClientResourcePersistence } from "@opencraft/document-storage/client-resources";

interface Stored extends ClientResourceRecord { identity: string; namespace: string; authority: "local" | "remote"; }

export async function openIndexedDbClientResources(name: string, factory: IDBFactory): Promise<ClientResourcePersistence> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    let expired = false;
    const fail = (error: unknown) => { expired = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error("Client resource storage opening timed out")), 5000);
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      const store = request.result.createObjectStore("resources", { keyPath: "identity" });
      store.createIndex("namespace", "namespace");
      store.createIndex("remote-age", ["authority", "savedAt"]);
    };
    request.onblocked = () => fail(new Error("Client resource storage blocked by another window"));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  function transaction<T>(mode: IDBTransactionMode, method: string, domain: string | undefined,
    operation: (store: IDBObjectStore, result: (value: T) => void, firstCallback: () => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const trace = traceBrowserStorage(method, "awaiting-first-callback", { mode, store: "resources",
        domain: domain === "conversation-draft" ? "conversation-draft" : "other" });
      let tx: IDBTransaction;
      try { tx = database.transaction("resources", mode); }
      catch (error) { trace?.finish("error"); throw error; }
      let value: T;
      tx.oncomplete = () => { trace?.finish("complete"); resolve(value); };
      const rejectTransaction = () => reject(tx.error ?? new Error("Client resource transaction failed"));
      tx.onerror = () => { trace?.finish("error"); rejectTransaction(); };
      tx.onabort = () => { trace?.finish("abort"); rejectTransaction(); };
      try { operation(tx.objectStore("resources"), result => { value = result; }, () => trace?.phase("first-callback-delivered")); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    async read(key) {
      const identity = resourceKey(key);
      return transaction<ClientResourceRecord | null>("readonly", "read", key.name, (store, result, firstCallback) => {
        const request = store.get(identity);
        request.onsuccess = () => {
          firstCallback();
          try {
            const row = request.result as Stored | undefined;
            if (!row) { result(null); return; }
            validateResourceRecord(row, row.revision, key.authority);
            result({ revision: row.revision, version: row.version, savedAt: row.savedAt, value: row.value });
          } catch { store.transaction.abort(); }
        };
      });
    },
    async compareAndSet(key: ClientResourceKey, revision: number, record: Omit<ClientResourceRecord, "revision">) {
      const identity = resourceKey(key);
      validateResourceRecord(record, revision, key.authority);
      return transaction<boolean>("readwrite", "compare-and-set", key.name, (store, result, firstCallback) => {
        const request = store.get(identity);
        request.onsuccess = () => {
          firstCallback();
          const current = request.result as Stored | undefined;
          if ((current?.revision ?? 0) !== revision) { result(false); return; }
          if (current && current.version > record.version) { store.transaction.abort(); return; }
          store.put({ ...record, value: structuredClone(record.value), revision: revision + 1,
            identity, namespace: key.namespace, authority: key.authority } satisfies Stored);
          if (key.authority === "remote") {
            const copies = store.index("remote-age").getAllKeys(IDBKeyRange.bound(["remote", 0], ["remote", Infinity]));
            copies.onsuccess = () => { for (const old of copies.result.slice(0, Math.max(0, copies.result.length - REMOTE_RESOURCE_LIMIT))) store.delete(old); };
          }
          result(true);
        };
      });
    },
    async clearRemoteNamespace(namespace) {
      return transaction<void>("readwrite", "clear-remote", undefined, (store, result, firstCallback) => {
        const cursor = store.index("namespace").openCursor(namespace);
        cursor.onsuccess = () => {
          firstCallback();
          const row = cursor.result;
          if (!row) { result(); return; }
          if ((row.value as Stored).authority === "remote") row.delete();
          row.continue();
        };
      });
    },
    async listLocalKeys(namespace, name) {
      resourceKey({ namespace, name, id: "namespace", authority: "local" });
      return transaction<readonly ClientResourceKey[]>("readonly", "list-local", name, (store, result, firstCallback) => {
        const keys: { key: ClientResourceKey; savedAt: number; identity: string }[] = [];
        const cursor = store.index("namespace").openCursor(namespace);
        cursor.onsuccess = () => {
          firstCallback();
          const row = cursor.result;
          if (!row) { result(keys.sort((a, b) => b.savedAt - a.savedAt || a.identity.localeCompare(b.identity)).map(row => row.key)); return; }
          const [scope, domain, id, authority] = JSON.parse(String(row.primaryKey));
          if (domain === name && authority === "local") keys.push({ key: { namespace: scope, name: domain, id, authority }, savedAt: (row.value as Stored).savedAt, identity: String(row.primaryKey) });
          row.continue();
        };
      });
    },
    async clearLocalResource(namespace, name) {
      resourceKey({ namespace, name, id: "namespace", authority: "local" });
      return transaction<void>("readwrite", "clear-local", name, (store, result, firstCallback) => {
        const cursor = store.index("namespace").openCursor(namespace);
        cursor.onsuccess = () => {
          firstCallback();
          const row = cursor.result;
          if (!row) { result(); return; }
          const [, domain, , authority] = JSON.parse(String(row.primaryKey));
          if (domain === name && authority === "local") row.delete();
          row.continue();
        };
      });
    },
    close() { database.close(); },
  };
}
