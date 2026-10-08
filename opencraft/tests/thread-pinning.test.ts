import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadPinsSnapshot, supportsThreadPinDiscovery } from "@opencraft/appserver-protocol";
import { ThreadPinningResource } from "../packages/workbench-runtime/src/thread-pinning-resource";
import { CodexThreadPins, CODEX_PINNED_SECTION_ID } from "../apps/opencraft-daemon/src/codex-thread-pins";
import { HermesDashboardSessionMetadataClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/session-metadata-client";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { changesThreadCatalog } from "../apps/workbench-web/src/runtime/thread-catalog-query";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";

const thread = (id = "old") => ({ id, cwd: "/project", preview: "Pinned", updatedAt: 1, turns: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

test("pin discovery is versioned and unsupported never contains rows", () => {
  assert.equal(supportsThreadPinDiscovery(null), false);
  assert.equal(supportsThreadPinDiscovery({ version: 2 }), false);
  assert.equal(supportsThreadPinDiscovery({ version: 1 }), true);
  assert.throws(() => parseThreadPinsSnapshot({ supported: false, data: [thread()] }));
  assert.throws(() => parseThreadPinsSnapshot({ supported: true, data: [thread(), thread()] }));
  assert.throws(() => parseThreadPinsSnapshot({ supported: true, data: [{ id: "x" }] }));
});

test("native Codex pins persist by re-read and backfill paginated old summaries without resume", async () => {
  let pinned = false;
  const calls: string[] = [];
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === "threadSection/list") return { data: [{ id: CODEX_PINNED_SECTION_ID }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, section: pinned ? { id: CODEX_PINNED_SECTION_ID } : null } };
    if (method === "thread/section/move") { pinned = params.sectionId !== null; return {}; }
    if (method === "thread/list") return { data: pinned ? [thread()] : [], nextCursor: null };
    throw new Error(`Unexpected ${method}`);
  };
  const pins = new CodexThreadPins(request);
  assert.deepEqual(await pins.list(), { supported: true, data: [] });
  await pins.set("old", true);
  assert.equal((await new CodexThreadPins(request).list()).data[0]!.id, "old");
  await pins.set("old", false);
  assert.equal((await pins.list()).data.length, 0);
  assert.equal(calls.some(method => method === "thread/resume" || method === "thread/start"), false);
});

test("unsupported Codex hides pins, transient errors remain errors and retry discovery", async () => {
  const absent = new CodexThreadPins(async () => { throw Object.assign(new Error("not found"), { code: -32601 }); });
  assert.deepEqual(await absent.list(), { supported: false, data: [] });
  await assert.rejects(absent.set("old", true));
  const oldSort = new CodexThreadPins(async method => {
    if (method === "threadSection/list") return { data: [{ id: CODEX_PINNED_SECTION_ID }], nextCursor: null };
    throw Object.assign(new Error("invalid params"), { code: -32602 });
  });
  assert.deepEqual(await oldSort.list(), { supported: false, data: [] });
  let fails = true;
  const pins = new CodexThreadPins(async () => { if (fails) throw new Error("offline"); return { data: [], nextCursor: null }; });
  await assert.rejects(pins.list(), /offline/);
  fails = false;
  assert.equal((await pins.list()).supported, false);
});

test("Codex unpin cannot remove an unrelated custom section and preserves pinned pagination order", async () => {
  const calls: string[] = [];
  const pins = new CodexThreadPins(async (method, params) => {
    calls.push(method);
    if (method === "threadSection/list") return { data: [{ id: CODEX_PINNED_SECTION_ID }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: "old", section: { id: "custom" } } };
    if (params.limit === 1) return { data: [], nextCursor: null };
    return params.cursor === "next" ? { data: [thread("second")], nextCursor: null } : { data: [thread("first")], nextCursor: "next" };
  });
  assert.deepEqual((await pins.list()).data.map(row => row.id), ["first", "second"]);
  await pins.set("old", false);
  assert.equal(calls.includes("thread/section/move"), false);
});

test("write intents serialize and a pre-write list cannot resurrect an unpinned session", async () => {
  let state = true, reads = 0;
  const oldRead = deferred<unknown>(), entered = deferred<void>(), write = deferred<void>();
  const order: boolean[] = [];
  const pins = new ThreadPinningResource({ current: () => true,
    read: async () => {
      if (++reads === 2) { entered.resolve(); return oldRead.promise; }
      return { supported: true, data: state ? [thread()] : [] };
    },
    write: async (_id, pinned) => { order.push(pinned); if (order.length === 1) await write.promise; state = pinned; return { pinned }; },
  });
  await pins.read();
  const reading = pins.read();
  await entered.promise;
  const first = pins.set("old", false);
  const second = pins.set("old", true);
  await Promise.resolve();
  assert.deepEqual(order, [false]);
  write.resolve();
  await Promise.all([first, second]);
  await pins.set("old", false);
  oldRead.resolve({ supported: true, data: [thread()] });
  assert.deepEqual((await reading).data, []);
  assert.deepEqual(order, [false, true, false]);
});

test("connection revocation rejects a late result and queued writes are never replayed", async () => {
  let current = true, calls = 0;
  const hold = deferred<{ pinned: boolean }>(), entered = deferred<void>();
  const pins = new ThreadPinningResource({ current: () => current,
    read: async () => ({ supported: true, data: [] }),
    write: async () => { ++calls; entered.resolve(); return hold.promise; },
  });
  await pins.read();
  const first = assert.rejects(pins.set("old", true));
  await entered.promise;
  const second = assert.rejects(pins.set("old", false));
  current = false;
  hold.resolve({ pinned: true });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(pins.available(), false);
});

test("failed writes release their tail and native state is re-read rather than fabricated", async () => {
  let fails = true;
  const pins = new ThreadPinningResource({ current: () => true,
    read: async () => ({ supported: true, data: [] }),
    write: async (_id, pinned) => { if (fails) throw new Error("denied"); return { pinned }; },
  });
  await pins.read();
  await assert.rejects(pins.set("old", true), /denied/);
  assert.deepEqual((await pins.read()).data, []);
  fails = false;
  await pins.set("old", true);
});

test("Hermes pinning uses the native authenticated metadata API and exact profile, not RPC pin/resume", async () => {
  let persisted = false, closed = false;
  const requests: Array<{ path: string; init: any }> = [];
  const client = new HermesDashboardSessionMetadataClient({
    async fetch(path, init) {
      requests.push({ path: String(path), init });
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body, { pinned: true, profile: "worker" });
        persisted = body.pinned;
        return Response.json({ ok: true, pinned: persisted });
      }
      return Response.json({ sessions: [{ id: "old", pinned: persisted, profile: "worker", title: "Old", preview: "Old", started_at: 1, cwd: "/remote" }] });
    }, close() { closed = true; },
  }, "synthetic-test-token");
  let event: ((event: Record<string, unknown>) => void) | undefined;
  const adapter = new HermesAppServerAdapter({ async call<T>() { throw new Error("No execution RPC allowed"); }, onEvent(listener) { event = listener; return () => {}; } }, "/", undefined, undefined, undefined, undefined, undefined, "worker");
  const notifications: string[] = [];
  adapter.subscribeNotification(method => notifications.push(method));
  try {
    assert.deepEqual((await adapter.listPinnedThreads(client)).data, []);
    await adapter.setThreadPinned(client, "old", true);
    const snapshot = await adapter.listPinnedThreads(client);
    assert.equal(snapshot.data[0]!.id, "old");
    assert.equal(snapshot.data[0]!.cwd, "/remote");
    assert.ok(requests[0]!.path.includes("profile=worker"));
    for (const req of requests) assert.equal(req.init.headers["X-Hermes-Session-Token"], "synthetic-test-token");
    event!({ type: "sessions.changed", payload: {} });
    assert.equal(notifications.filter(method => method === "thread/pins/updated").length, 2);
    assert.equal(changesThreadCatalog("thread/pins/updated"), true);
  } finally { adapter.dispose(); client.dispose(); }
  assert.equal(closed, true);
});

test("Hermes rejects wrong profile and an unconfirmed native write", async () => {
  const client = new HermesDashboardSessionMetadataClient({
    async fetch(_path, init) { return Response.json(init?.method === "PATCH" ? { ok: true } : { sessions: [{ id: "s", profile: "other", pinned: true }] }); }, close() {},
  }, "synthetic-test-token");
  await assert.rejects(client.readPinned("worker"), /ownership/);
  await assert.rejects(client.setPinned("s", "worker", true), /尚未确认/);
});

test("Hermes permits native NULL summaries and distinguishes unsupported API from transient failures", async () => {
  let status = 200;
  const client = new HermesDashboardSessionMetadataClient({
    async fetch() {
      return status === 200 ? Response.json({ sessions: [{ id: "empty", profile: "worker", pinned: true, title: null, preview: null, started_at: 1 }] }) : new Response(null, { status });
    }, close() {},
  }, "synthetic-test-token");
  assert.equal((await client.readPinned("worker")).rows[0]!.title, "");
  status = 404;
  assert.deepEqual(await client.readPinned("worker"), { supported: false, rows: [] });
  status = 503;
  await assert.rejects(client.readPinned("worker"), /无法读取/);
});

test("runtime discovers pins only on initial catalogs and merges old rows once across reload", async () => {
  let persisted = true;
  const requests: string[] = [];
  const makeRuntime = () => createAppServerWorkbenchRuntime({ hostId: "native", hostKind: "remote-ssh", autoReconnect: false,
    transport: new MemoryTransport({ receive(frame, peer) {
      const request = JSON.parse(frame);
      if (request.id === undefined) return;
      requests.push(request.method);
      let result: unknown;
      switch (request.method) {
        case "initialize": result = { codexHome: "/synthetic", capabilities: { extensions: { "opencraft/thread-pins": { version: 1 } } } }; break;
        case "opencraft/thread-pins/list": result = { supported: true, data: persisted ? [thread()] : [] }; break;
        case "opencraft/thread-pins/set": persisted = request.params.pinned; result = { pinned: persisted }; break;
        default: result = { data: [thread("new"), thread()], nextCursor: null };
      }
      peer.send(JSON.stringify({ id: request.id, result }));
    } }),
  });
  let runtime = makeRuntime();
  try {
    await runtime.connect();
    assert.equal(runtime.resources.threads.capabilities!().pin, false);
    let page = await runtime.resources.threads.list({ limit: 1 });
    assert.deepEqual(page.data.map(row => [row.id, row.pinned]), [["old", true], ["new", false]]);
    assert.equal(runtime.resources.threads.capabilities!().pin, true);
    const reads = requests.filter(method => method === "opencraft/thread-pins/list").length;
    await runtime.resources.threads.list({ cursor: "next", limit: 1 });
    assert.equal(requests.filter(method => method === "opencraft/thread-pins/list").length, reads);
    await runtime.resources.threads.setPinned!("old", false);
    page = await runtime.resources.threads.list();
    assert.equal(page.data.find(row => row.id === "old")!.pinned, false);
    await runtime.resources.threads.setPinned!("old", true);
    await runtime.dispose();
    runtime = makeRuntime();
    await runtime.connect();
    page = await runtime.resources.threads.list();
    assert.equal(page.data[0]!.pinned, true);
    assert.equal(requests.some(method => ["thread/resume", "thread/start", "turn/start"].includes(method)), false);
  } finally { await runtime.dispose(); }
});

test("SSH broker adapts pin RPCs to native metadata rather than forwarding the extension", async () => {
  let pinned = false;
  const native: string[] = [], frames: any[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const message = JSON.parse(frame);
    native.push(message.method);
    if (message.id === undefined) return;
    let result: unknown;
    switch (message.method) {
      case "initialize": result = { codexHome: "/remote" }; break;
      case "threadSection/list": result = { data: [{ id: CODEX_PINNED_SECTION_ID }], nextCursor: null }; break;
      case "thread/read": result = { thread: { id: "old", section: pinned ? { id: CODEX_PINNED_SECTION_ID } : null } }; break;
      case "thread/section/move": pinned = message.params.sectionId !== null; result = {}; break;
      default: result = { data: pinned ? [thread()] : [], nextCursor: null };
    }
    peer.send(JSON.stringify({ id: message.id, result }));
  } });
  const adapter = new CodexEngineAdapter({ kind: "remote", transport });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await adapter.connect();
    const send = async (id: string, method: string, params = {}) => {
      await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "pin-client" }));
      for (let i = 0; i < 20 && !frames.some(frame => frame.id === id); ++i) await new Promise(resolve => setTimeout(resolve, 1));
      const response = frames.find(frame => frame.id === id);
      assert.ok(response, `missing ${id}`);
      assert.equal(response[LOGICAL_CLIENT_FIELD], "pin-client");
      assert.equal(response.error, undefined);
      return response.result;
    };
    const initialize = await send("init", "initialize");
    assert.equal(initialize.capabilities.extensions["opencraft/thread-pins"].version, 1);
    assert.equal((await send("list", "opencraft/thread-pins/list")).supported, true);
    await send("set", "opencraft/thread-pins/set", { threadId: "old", pinned: true });
    assert.equal((await send("again", "opencraft/thread-pins/list")).data[0].id, "old");
    assert.equal(native.some(method => method.startsWith("opencraft/thread-pins/")), false);
    assert.equal(native.some(method => ["thread/resume", "thread/start"].includes(method)), false);
  } finally { await adapter.close(); }
});
