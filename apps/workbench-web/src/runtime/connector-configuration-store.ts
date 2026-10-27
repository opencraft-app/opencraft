import { serverStorageKey } from "./server-context";
import { emptyConnectorConfiguration, parseConnectorConfiguration, type ConnectorConfigurationRecord, type ConnectorConfigurationStore } from "@opencraft/workbench-runtime";
import { workbenchProductId } from "../workbench-product";

export async function openConnectorConfigurationStore(factory: IDBFactory = indexedDB): Promise<ConnectorConfigurationStore> {
  const desktop = (globalThis as typeof globalThis & { opencraftDesktop?: { connectorConfiguration?: ConnectorConfigurationStore } }).opencraftDesktop?.connectorConfiguration;
  if (desktop) return desktop;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(serverStorageKey(`${workbenchProductId}-connector-configuration`), 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(serverStorageKey(`${workbenchProductId}:connector-configuration`)) : null;
  const listeners = new Set<() => void>();
  if (channel) channel.onmessage = () => { for (const listener of listeners) listener(); };
  const load = () => new Promise<ConnectorConfigurationRecord>((resolve, reject) => {
    const tx = database.transaction("state", "readonly"), read = tx.objectStore("state").get("configuration");
    tx.oncomplete = () => { try { const row = read.result; resolve(row ? { revision: row.revision, value: parseConnectorConfiguration(row.value) } : { revision: 0, value: emptyConnectorConfiguration() }); } catch (error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
  });
  return {
    load,
    compareAndSet: (expected, input) => new Promise((resolve, reject) => {
      const value = parseConnectorConfiguration(input), tx = database.transaction("state", "readwrite"), store = tx.objectStore("state");
      let result: { updated: boolean; record: ConnectorConfigurationRecord };
      const read = store.get("configuration");
      read.onsuccess = () => {
        const current = read.result ?? { revision: 0, value: emptyConnectorConfiguration() };
        result = current.revision === expected ? { updated: true, record: { revision: expected + 1, value } } : { updated: false, record: current };
        if (result.updated) store.put(result.record, "configuration");
      };
      tx.oncomplete = () => { if (result.updated) channel?.postMessage("changed"); resolve(result); };
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("Connector write aborted"));
    }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { channel?.close(); listeners.clear(); database.close(); },
  };
}
