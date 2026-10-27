import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { openHostDocumentPersistence } from "@opencraft/workbench-runtime";
import { openIndexedDbExtensionPersistence } from "../../apps/workbench-web/src/runtime/indexeddb-extension-persistence";
import type { ExtensionDocument, ExtensionStorageApiV1 } from "@opencraft/extension-contract";

const local = await openIndexedDbExtensionPersistence("host-document-local-fixture");
const clients = new Map<string, JsonRpcAppServerClient>();
async function connect(id: string) {
  const urls = await (await fetch("/fixture-hosts")).json();
  const previous = clients.get(id);
  const client = new JsonRpcAppServerClient({ hostId: id, transport: new WebSocketTransport(urls[id]) });
  await client.connect({ clientInfo: { name: "isolated-storage-fixture", version: "1" } });
  clients.set(id, client); await previous?.close();
}
await connect("a"); await connect("b");
const runtime = new ExtensionSupervisor({ platform: "web", persistence: local, resolveHostPersistence: async (id, signal) => {
  const client = clients.get(id); if (!client) throw new Error("Host unavailable");
  return openHostDocumentPersistence(client, { signal, isCurrent: () => clients.get(id) === client });
} });
let storage!: ExtensionStorageApiV1;
await runtime.activate({ manifest: { manifestVersion: 1, id: "fixture.host-documents", name: "Host storage fixture", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate(api) { storage = api.storage!; } });
const handles = new Map<string, ExtensionDocument>();
let changes = 0;
async function open(id: string) {
  const value = await (await storage.forHost(id)).open("state");
  handles.set(id, value); value.subscribe(() => changes++);
}
await open("a"); await open("b");
(window as any).hostDocumentProbe = {
  read: (id: string) => handles.get(id)!.read(),
  save: (id: string, revision: number, value: any) => handles.get(id)!.compareAndSet(revision, value),
  changes: () => changes,
  local: () => local.read("plugin/fixture.host-documents/state"),
  async reconnect(id: string) { await connect(id); await open(id); },
};
document.body.textContent = "Isolated Host document API ready";
