import type { ExtensionJson } from "@opencraft/extension-contract";
import { serializeExtensionData, validateDataRevision, validateDataScope, validateDataVersion, parseExtensionDataRecord, validateDocumentTransition,
  type ExtensionPersistence, type ExtensionDataRecord, type ExtensionDataCommit } from "@opencraft/extension-runtime";

export async function openIndexedDbExtensionPersistence(name: string, factory: IDBFactory = indexedDB): Promise<ExtensionPersistence> {
  let closed = false;
  const listeners = new Set<(scope: string) => void>();
  const notify = (scope: string) => { for (const listener of listeners) { try { listener(scope); } catch { /* Observer only. */ } } };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    let rejected = false;
    request.onupgradeneeded = () => { if (!rejected) request.result.createObjectStore("records"); else request.transaction?.abort(); };
    request.onblocked = () => { rejected = true; reject(new Error("Extension storage upgrade blocked by another window")); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`${name}:changes`) : null;
  if (channel) channel.onmessage = event => { if (typeof event.data === "string") notify(event.data); };
  function close() { closed = true; database.close(); channel?.close(); listeners.clear(); }
  database.onversionchange = () => { closed = true; database.close(); channel?.close(); notify("*"); listeners.clear(); };
  function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    if (closed) return Promise.reject(new Error("Extension storage connection closed; reload required"));
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction("records", mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("Extension storage transaction aborted"));
      tx.onerror = () => reject(tx.error);
      try { work(tx.objectStore("records"), result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    read(scope) {
      validateDataScope(scope);
      return transaction<ExtensionDataRecord | null>("readonly", (store, result) => {
        const request = store.get(scope); request.onsuccess = () => result(request.result ?? null);
      }).then(parseExtensionDataRecord);
    },
    async compareAndSet(scope, revision, version, input) {
      validateDataScope(scope); validateDataRevision(revision); validateDataVersion(version);
      const value = JSON.parse(serializeExtensionData(input)) as ExtensionJson;
      const committed = await transaction<ExtensionDataCommit>("readwrite", (store, result) => {
        const request = store.get(scope);
        request.onsuccess = () => {
          let current: ExtensionDataRecord | null;
          try { current = parseExtensionDataRecord(request.result); }
          catch { store.transaction.abort(); return; }
          if ((current?.revision ?? 0) !== revision) { result({ updated: false, record: current }); return; }
          try { validateDocumentTransition(current, version); } catch { store.transaction.abort(); return; }
          const record = { revision: revision + 1, version, value };
          store.put(record, scope); result({ updated: true, record });
        };
      });
      if (committed.updated) {
        notify(scope);
        try { channel?.postMessage(scope); } catch { /* The transaction already committed; observers may be closing. */ }
      }
      return committed;
    },
    subscribe(listener) { if (closed) throw new Error("Extension storage closed"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    close,
  };
}
