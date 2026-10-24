import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClientError, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage, type AppServerInitializeResponse } from "@opencraft/appserver-protocol";

const initializeResponse: AppServerInitializeResponse = { codexHome: "/tmp/preparation-fixture", platformFamily: "unix", platformOs: "linux", userAgent: "owned-preparation-test/1" };
const initializeParams = { clientInfo: { name: "preparation-tests", version: "1" }, capabilities: { experimentalApi: true } } as const;

test("context preparation extends only matching admission requests and cannot renew the absolute deadline", async () => {
  for (const method of ["turn/start", "thread/resume", "thread/read"]) {
    let now = 0, sequence = 0;
    const timers = new Map<number, { at: number; run(): void }>();
    let notify: (method: string, params: unknown) => void = () => { throw Error("no peer"); };
    const transport = new MemoryTransport({ schedule: callback => callback(), server: { receive(frame, peer) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      notify = (method, params) => peer.send(encodeJsonRpcMessage({ method, params }));
      if (request.method === "initialize") peer.send(encodeJsonRpcMessage({ id: request.id, result: initializeResponse }));
    } } });
    const client = new JsonRpcAppServerClient({ hostId: "preparation", transport, clock: {
      now: () => now,
      setTimeout: (run, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, run }); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: id => { timers.delete(id as unknown as number); },
    } });
    const advance = (to: number) => { now = to; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } };
    try {
      await client.connect(initializeParams);
      const pending = client.requestRaw(method, { threadId: "source" }); pending.catch(() => {});
      await Promise.resolve();
      notify("item/started", { threadId: "other", turnId: "unrelated", item: { type: "contextCompaction" } });
      assert.equal([...timers.values()][0]?.at, 30_000);
      notify("item/started", { threadId: "source", turnId: "compact", item: { type: "contextCompaction" } });
      if (method === "thread/read") {
        advance(30_001); await assert.rejects(pending, (e: unknown) => e instanceof AppServerClientError && e.code === "TIMEOUT");
      } else {
        advance(40_000); assert.equal(client.getPendingRequestCount(), 1, "model preparation survives the short RPC timeout");
        notify("turn/completed", { threadId: "source", turn: { id: "unrelated" } });
        notify("item/started", { threadId: "source", turnId: "compact", item: { type: "contextCompaction" } });
        assert.equal([...timers.values()][0]?.at, 180_000, "duplicates do not extend the absolute deadline");
        advance(180_001); await assert.rejects(pending, (e: unknown) => e instanceof AppServerClientError && e.code === "TIMEOUT");
      }
      assert.equal(timers.size, 0);
    } finally { await client.close(); }
  }
});

test("matching compaction completion restores the response deadline and cancellation still releases it", async () => {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  let notify: (method: string, params: unknown) => void = () => { throw Error("no peer"); };
  const transport = new MemoryTransport({ schedule: callback => callback(), server: { receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    notify = (method, params) => peer.send(encodeJsonRpcMessage({ method, params }));
    if (request.method === "initialize") peer.send(encodeJsonRpcMessage({ id: request.id, result: initializeResponse }));
  } } });
  const client = new JsonRpcAppServerClient({ hostId: "preparation-cancel", transport, clock: {
    now: () => now,
    setTimeout: (run, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, run }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: id => { timers.delete(id as unknown as number); },
  } });
  try {
    await client.connect(initializeParams);
    const controller = new AbortController();
    const pending = client.requestRaw("turn/start", { threadId: "source" }, { signal: controller.signal }); pending.catch(() => {});
    await Promise.resolve();
    notify("item/started", { threadId: "source", turnId: "compact", item: { type: "contextCompaction" } });
    now = 40_000;
    notify("turn/completed", { threadId: "source", turn: { id: "compact" } });
    assert.equal([...timers.values()][0]?.at, 70_000);
    controller.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof AppServerClientError && e.code === "ABORTED");
    assert.equal(timers.size, 0); assert.equal(client.getPendingRequestCount(), 0);
  } finally { await client.close(); }
});
