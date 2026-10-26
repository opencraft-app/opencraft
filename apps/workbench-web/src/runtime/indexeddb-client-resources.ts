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
  function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = database.transaction("resources", mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Client resource transaction failed"));
      try { operation(tx.objectStore("resources"), result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    async read(key) {
      const identity = resourceKey(key);
      return transaction<ClientResourceRecord | null>("readonly", (store, result) => {
        const request = store.get(identity);
        request.onsuccess = () => {
          try {
            const row = request.result as Stored | undefined;
            if (!row) { result(null); return; }
            validateResourceRecord(row, row.revision);
            result({ revision: row.revision, version: row.version, savedAt: row.savedAt, value: row.value });
          } catch { store.transaction.abort(); }
        };
      });
    },
    async compareAndSet(key: ClientResourceKey, revision: number, record: Omit<ClientResourceRecord, "revision">) {
      const identity = resourceKey(key);
      validateResourceRecord(record, revision);
      return transaction<boolean>("readwrite", (store, result) => {
        const request = store.get(identity);
        request.onsuccess = () => {
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
      return transaction<void>("readwrite", (store, result) => {
        const cursor = store.index("namespace").openCursor(namespace);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { result(); return; }
          if ((row.value as Stored).authority === "remote") row.delete();
          row.continue();
        };
      });
    },
    close() { database.close(); },
  };
}
