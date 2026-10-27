import type { ClientResourcePersistence } from "@opencraft/document-storage/client-resources";
import { openIndexedDbClientResources } from "./indexeddb-client-resources";

/** Storage choice belongs to application composition, never to a list or editor. */
export async function openClientResourcePersistence(databaseName: string): Promise<ClientResourcePersistence> {
  const desktop = (globalThis as typeof globalThis & {
    opencraftDesktop?: { clientResources?: Omit<ClientResourcePersistence, "close"> };
  }).opencraftDesktop;
  if (desktop) {
    if (!desktop.clientResources) throw new Error("Client resource bridge unavailable; restart the desktop application");
    return { ...desktop.clientResources, close() {} };
  }
  return openIndexedDbClientResources(databaseName, indexedDB);
}
