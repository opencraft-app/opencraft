import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { HOST_STORAGE } from "@opencraft/appserver-protocol/host-storage";
import { HostDocumentService } from "../apps/local-agent-host/src/storage/host-document-service.ts";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.ts";

test("Host document service validates requests, preserves CAS and emits no values", async () => {
  const unconfigured = new HostDocumentService(null);
  assert.throws(() => unconfigured.handle(HOST_STORAGE.capabilities, {}), /configured data directory/);
  unconfigured.close();
  const root = await mkdtemp("/tmp/oc-host-documents-");
  let service = new HostDocumentService(join(root, "data.sqlite"));
  try {
    const changes: unknown[] = []; service.subscribe(value => changes.push(value));
    assert.equal((service.handle(HOST_STORAGE.capabilities, {}) as any).authority, "host-session");
    for (const raw of [{ scope: "ok", path: "/tmp/forbidden" }, { scope: "ok", principalId: "other" }, { scope: "a\0b" }]) {
      assert.throws(() => service.handle(HOST_STORAGE.read, raw), /Invalid/);
    }
    assert.equal(service.handle(HOST_STORAGE.read, { scope: "example/state" }), null);
    assert.equal((service.handle(HOST_STORAGE.compareAndSet, { scope: "example/state", revision: 0, version: 1, value: { count: 1 } }) as any).updated, true);
    assert.equal((service.handle(HOST_STORAGE.compareAndSet, { scope: "example/state", revision: 0, version: 1, value: "stale" }) as any).updated, false);
    assert.deepEqual(changes, [{ scope: "example/state", revision: 1 }]);
    assert.throws(() => service.handle(HOST_STORAGE.compareAndSet, { scope: "example/state", revision: 1, version: 1, value: "x".repeat(1024 * 1024) }), /limit/);
    service.close(); service = new HostDocumentService(join(root, "data.sqlite"));
    assert.deepEqual(service.handle(HOST_STORAGE.read, { scope: "example/state" }), { revision: 1, version: 1, value: { count: 1 } });
    service.handle(HOST_STORAGE.compareAndSet, { scope: "example/state", revision: 1, version: 2, value: { count: 2 } });
    assert.throws(() => service.handle(HOST_STORAGE.compareAndSet, { scope: "example/state", revision: 2, version: 1, value: {} }), /newer data format/);
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const changes: unknown[] = [];
  socket.on("message", data => { const value = JSON.parse(String(data)); if (value.method === HOST_STORAGE.changed) changes.push(value.params); });
  return {
    socket, changes,
    call(method: string, params: unknown): Promise<any> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Fixture RPC timed out")); }, 4000);
        const receive = (data: WebSocket.RawData) => {
          const value = JSON.parse(String(data)); if (value.id !== id) return;
          clearTimeout(timer); socket.off("message", receive);
          if (value.error) reject(new Error(value.error.message)); else resolve(value.result);
        };
        socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
  };
}

test("actual authenticated Host RPC works without engine availability, notifies peers and survives restart", async () => {
  const root = await mkdtemp("/tmp/oc-host-rpc-documents-");
  let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
  let a: Awaited<ReturnType<typeof connect>> | undefined, b: typeof a;
  try {
    const options = { dshUrl: "http://127.0.0.1:1", dataDirectory: root };
    host = await startLocalAgentHost(options);
    const bad = new URL(host.websocketUrl); bad.searchParams.set("token", "invalid-fixture-token");
    const denied = new WebSocket(bad);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      denied.on("error", () => {});
      denied.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); denied.terminate(); });
      denied.once("open", () => { denied.close(); reject(new Error("Unauthenticated socket accepted")); });
    });
    assert.equal(status, 401);
    a = await connect(host.websocketUrl); b = await connect(host.websocketUrl);
    await a.call(HOST_STORAGE.capabilities, {}); await b.call(HOST_STORAGE.capabilities, {});
    await a.call(HOST_STORAGE.compareAndSet, { scope: "plugin/fixture/state", revision: 0, version: 1, value: { shared: true } });
    assert.equal((await b.call(HOST_STORAGE.read, { scope: "plugin/fixture/state" })).value.shared, true);
    assert.deepEqual(b.changes, [{ scope: "plugin/fixture/state", revision: 1 }]);
    assert.equal((await b.call(HOST_STORAGE.compareAndSet, { scope: "plugin/fixture/state", revision: 0, version: 1, value: {} })).updated, false);
    a.socket.close(); b.socket.close(); await host.close();
    host = await startLocalAgentHost(options); a = await connect(host.websocketUrl);
    assert.equal((await a.call(HOST_STORAGE.read, { scope: "plugin/fixture/state" })).revision, 1);
  } finally { a?.socket.close(); b?.socket.close(); await host?.close(); await rm(root, { recursive: true, force: true }); }
});
