import { createPersistentExtensionInstallations, createPersistentExtensionSettingsStorage, type ExtensionPersistence } from "@opencraft/extension-runtime";
import { openIndexedDbExtensionPersistence } from "./indexeddb-extension-persistence";

/** Read only a known database in the current origin. Never enumerate unrelated origins. */
async function legacyRows(name: string, store: string): Promise<readonly unknown[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let missing = false, rejected = false;
    request.onupgradeneeded = () => { missing = true; request.transaction?.abort(); };
    request.onerror = () => missing ? resolve([]) : reject(request.error);
    request.onblocked = () => { rejected = true; reject(new Error("Legacy extension storage blocked by another window")); };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      db.onversionchange = () => db.close();
      if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error("Unknown legacy extension storage schema")); return; }
      const tx = db.transaction(store, "readonly"), read = tx.objectStore(store).getAll();
      tx.oncomplete = () => { db.close(); resolve(read.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

export async function openClientExtensionPersistence(currentProductDatabaseName: (base: string) => string) {
  const desktop = (globalThis as typeof globalThis & { opencraftDesktop?: { extensionData?: Omit<ExtensionPersistence, "close"> } }).opencraftDesktop;
  if (desktop && !desktop.extensionData) throw new Error("Desktop extension storage bridge unavailable; restart with the matching application build");
  const backend: ExtensionPersistence = desktop?.extensionData
    ? { ...desktop.extensionData, close() {} }
    : await openIndexedDbExtensionPersistence(currentProductDatabaseName("vela-extension-data"));
  try {
    const settings = await createPersistentExtensionSettingsStorage(backend, () => legacyRows(currentProductDatabaseName("vela-extension-settings"), "values"));
    const installations = await createPersistentExtensionInstallations(backend, () => legacyRows(currentProductDatabaseName("vela-extension-installations"), "installations"));
    return { backend, settings, installations };
  } catch (error) { await backend.close(); throw error; }
}
