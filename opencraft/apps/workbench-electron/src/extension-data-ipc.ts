import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { SqliteDocumentStore as DesktopExtensionDataStore } from "@opencraft/document-storage/sqlite";

/** Only the trusted application renderer receives this internal backend port. */
export function registerExtensionDataIpc(store: () => DesktopExtensionDataStore, trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle("opencraft:extension-data-read", (event, scope: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted extension storage caller");
    return store().read(scope);
  });
  ipcMain.handle("opencraft:extension-data-commit", (event, scope: unknown, revision: unknown, version: unknown, value: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted extension storage caller");
    const result = store().compareAndSet(scope, revision, version, value);
    if (result.updated && !event.sender.isDestroyed()) event.sender.send("opencraft:extension-data-changed", scope);
    return result;
  });
}
