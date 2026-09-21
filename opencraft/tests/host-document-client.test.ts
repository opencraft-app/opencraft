import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { ExtensionSupervisor, MemoryExtensionPersistence, type TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import { openHostDocumentPersistence } from "@opencraft/workbench-runtime";
import { HostDocumentService } from "../apps/local-agent-host/src/storage/host-document-service.ts";
import { HOST_STORAGE } from "@opencraft/appserver-protocol/host-storage";

async function peer(hostId: string, path: string, supported = true) {
  const service = new HostDocumentService(path);
  let connection: any;
  const remove = service.subscribe(params => connection?.send(JSON.stringify({ jsonrpc: "2.0", method: HOST_STORAGE.changed, params })));
  const transport = new MemoryTransport({ receive(frame, active) {
    connection = active; const message = JSON.parse(frame); if (!Object.hasOwn(message, "id")) return;
    try {
      if (!supported && message.method !== "initialize") throw new Error("unsupported");
      const result = message.method === "initialize" ? { userAgent: "fixture", codexHome: "/tmp/fixture", platformFamily: "unix", platformOs: "test" } : service.handle(message.method, message.params);
      active.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch { active.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } })); }
  } });
  const client = new JsonRpcAppServerClient({ hostId, transport });
  await client.connect({ clientInfo: { name: "fixture", version: "1" } });
  return { client, async close() { remove(); await client.close(); service.close(); } };
}

test("SDK binds explicit Host, keeps local data separate, fences replacement and never falls back", async () => {
  const root = await mkdtemp("/tmp/oc-host-client-documents-");
  const a = await peer("a", join(root, "a.sqlite")), b = await peer("b", join(root, "b.sqlite")), old = await peer("old", join(root, "old.sqlite"), false);
  const clients = new Map([["a", a.client], ["b", b.client], ["old", old.client]]);
  const local = new MemoryExtensionPersistence();
  const runtime = new ExtensionSupervisor({ platform: "web", persistence: local, resolveHostPersistence: async (id, signal) => {
    const client = clients.get(id); if (!client) throw new Error("Host unavailable");
    return openHostDocumentPersistence(client, { signal, isCurrent: () => clients.get(id) === client });
  } });
  try {
    let api!: TrustedExtensionApiV1;
    await runtime.activate({ manifest: { manifestVersion: 1, id: "test.remote", name: "Remote fixture", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate(value) { api = value; } });
    const da = await (await api.storage!.forHost("a")).open("state");
    const db = await (await api.storage!.forHost("b")).open("state");
    const first = await da.read(); let changes = 0; da.subscribe(() => changes++);
    await da.compareAndSet(first.revision, { target: "a" });
    assert.deepEqual((await db.read()).value, {}); assert.ok(changes > 0);
    assert.equal(await local.read("plugin/test.remote/state"), null);
    await assert.rejects(api.storage!.forHost("old"), /unsupported/);
    await assert.rejects(api.storage!.forHost("missing"), /unavailable/);
    clients.delete("a"); await assert.rejects(da.read(), /changed/);
    await b.client.close(); await assert.rejects(db.read(), /unavailable/);
    await runtime.deactivate("test.remote");
    assert.equal(a.client.status.state, "open", "plugin disposal must not close a borrowed application Host client");
    await assert.rejects(da.compareAndSet(first.revision + 1, {}), /stale/);
    assert.equal(await local.read("plugin/test.remote/state"), null);
  } finally { await runtime.dispose(); local.close(); await a.close(); await b.close(); await old.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host document access does not require a local persistence implementation", async () => {
  const root = await mkdtemp("/tmp/oc-host-only-documents-");
  const remote = await peer("remote", join(root, "data.sqlite"));
  const runtime = new ExtensionSupervisor({ platform: "web", resolveHostPersistence: async (_id, signal) => openHostDocumentPersistence(remote.client, { signal, isCurrent: () => true }) });
  try {
    let api!: TrustedExtensionApiV1;
    await runtime.activate({ manifest: { manifestVersion: 1, id: "test.host-only", name: "Host only", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate(value) { api = value; } });
    await assert.rejects(api.storage!.open("state"), /Client-local/);
    const document = await (await api.storage!.forHost("remote")).open("state");
    assert.deepEqual((await document.read()).value, {});
  } finally { await runtime.dispose(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});
