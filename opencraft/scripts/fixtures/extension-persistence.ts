import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import type { ExtensionDocument } from "@opencraft/extension-contract";
import { openClientExtensionPersistence } from "../../apps/workbench-web/src/runtime/client-extension-persistence";

await new Promise<void>((resolve, reject) => {
  const request = indexedDB.open("fixture-vela-extension-settings", 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("values", { keyPath: "key" });
    store.put({ key: "fixture.storage.preferences\u0000enabled", contributionId: "fixture.storage.preferences", fieldKey: "enabled", value: true });
  };
  request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error);
});
const platform = await openClientExtensionPersistence(base => `fixture-${base}`);
const backend = platform.backend;
const supervisor = new ExtensionSupervisor({ platform: "web", persistence: backend });
let documentHandle: ExtensionDocument;
let notifications = 0, workerMessages = 0, workerDisposed = false;
async function activate(version = 1) {
  await supervisor.activate({
    manifest: { manifestVersion: 1, id: "fixture.storage", name: "Storage fixture", version: `${version}.0.0`, apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] },
    async activate(api) {
      documentHandle = await api.storage!.open("state", version === 1 ? undefined : {
        version: 2, initialValue: {}, migrations: [{ version: 2, checksum: "a".repeat(64), migrate(value) { return { ...value as object, upgraded: true }; } }],
      });
      documentHandle.subscribe(() => { notifications++; });
      const worker = new Worker(new URL("./extension-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = () => { workerMessages++; };
      api.subscriptions.add(() => { worker.terminate(); workerDisposed = true; });
    },
  });
}
await activate();
(window as any).extensionStorageProbe = {
  read: () => documentHandle.read(),
  save: (revision: number, value: any) => documentHandle.compareAndSet(revision, value),
  notifications: () => notifications,
  workerMessages: () => workerMessages,
  workerDisposed: () => workerDisposed,
  legacySettings: () => platform.settings.load(),
  async upgrade() { await supervisor.deactivate("fixture.storage"); await activate(2); },
  async stop() { await supervisor.dispose(); },
};
document.body.textContent = "Isolated extension persistence ready";
