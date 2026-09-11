import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { RecordingTransport } from "@opencraft/appserver-transport-replay";
import { HermesDashboardFileSystem } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/dashboard-file-system";

test("client expiry aborts underlying local read before a replacement can start", async () => {
  const physical = new MemoryTransport({ receive(frame, peer) {
    const request = JSON.parse(frame);
    if (request.method === "initialize") peer.send(JSON.stringify({ id: request.id, result: {} }));
  }});
  let signal: AbortSignal | undefined;
  const original = physical.send.bind(physical);
  physical.send = async (frame: string, requestSignal?: AbortSignal) => {
    if (JSON.parse(frame).method === "fs/readFile") signal = requestSignal;
    await original(frame);
  };
  const client = new JsonRpcAppServerClient({ hostId: "test", transport: new RecordingTransport({ transport: physical }) });
  await client.connect({ clientInfo: { name: "test", version: "1" } });
  await assert.rejects(client.requestRaw("fs/readFile", { path: "/image" }, { timeoutMs: 5 }), /timed out/);
  assert.equal(signal?.aborted, true);
  await client.close();
});

test("cancelled image read releases its request and never falls back", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fs = new HermesDashboardFileSystem({
    fetchJson: async (_path, init) => {
      calls++;
      assert.equal(init?.signal, controller.signal);
      return await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }, close() {},
  }, "test");
  const operation = fs.readFile("/image", controller.signal);
  controller.abort(new Error("expired"));
  await assert.rejects(operation, /expired/);
  assert.equal(calls, 1);
});

test("image route fallback is restricted to unsupported routes, not transient failures", async () => {
  for (const message of ["HTTP 403: forbidden", "HTTP 500: failed", "timeout", "HTTP 404: missing"]) {
    let calls = 0;
    const fs = new HermesDashboardFileSystem({ async fetchJson<T>() {
      calls++;
      if (calls === 1) throw new Error(message);
      return { data_url: "data:image/png;base64,YQ==" } as T;
    }, close() {} }, "test");
    if (message.startsWith("HTTP 404")) assert.deepEqual(await fs.readFile("/image"), { dataBase64: "YQ==" });
    else await assert.rejects(fs.readFile("/image"), { message });
    assert.equal(calls, message.startsWith("HTTP 404") ? 2 : 1);
  }
});
