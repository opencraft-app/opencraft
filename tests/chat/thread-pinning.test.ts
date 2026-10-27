import assert from "node:assert/strict";

import test from "node:test";

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer } from "ws";

import { parseThreadPinsSnapshot, supportsThreadPinDiscovery } from "@opencraft/appserver-protocol";

import { ThreadPinningResource } from "../../packages/workbench-runtime/src/thread-pinning-resource";

import { CodexThreadPins, CODEX_PINNED_SECTION_ID } from "../../apps/opencraft-daemon/src/codex-thread-pins";

import { changesThreadCatalog } from "../../apps/workbench-web/src/runtime/thread-catalog-query";

import { MemoryTransport } from "@opencraft/appserver-transport-memory";

import { WebSocketTransport } from "../../packages/appserver-transport-websocket/src/websocket-transport";

import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";

import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter";

import { startEngineHost } from "../../apps/local-agent-host/src/engine-host";

import { PiEngine } from "../../plugins/pi-engine/src/index";

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


test("DSH advertises and persists ordered pins without opening sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencraft-dsh-pins-"));
  const summaries = [
    { sessionId: "s1", updatedAt: 1_788_000_000_000, running: false, blank: false, cwd: "/workspace/demo", projections: { asOfSeq: 1, values: { title: "One" } } },
    { sessionId: "s2", updatedAt: 1_788_000_000_100, running: false, blank: false, cwd: "/workspace/demo", projections: { asOfSeq: 1, values: { title: "Two" } } },
    { sessionId: "blank", updatedAt: 1_788_000_000_200, running: false, blank: true, cwd: "/workspace/demo" },
  ];
  const calls: string[] = [];
  const client = {
    async call(method: string) {
      calls.push(method);
      if (method === "host.describe") return { home };
      if (method === "session.list") return { items: summaries };
      throw new Error(`Unexpected DSH method ${method}`);
    },
    stream(_path: string, _onFrame: unknown, signal: AbortSignal, onOpen?: () => void) {
      onOpen?.();
      return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  const open = async () => {
    const adapter = new DshAppServerAdapter(client as any);
    const initialized = await adapter.dispatch("initialize", {}) as any;
    return { adapter, initialized };
  };
  const first = await open();
  try {
    assert.deepEqual(first.initialized.capabilities.extensions["opencraft/thread-pins"], { version: 1 });
    assert.equal(first.initialized.capabilities.extensions["opencraft/thread-lifecycle"].pin, true);
    assert.deepEqual(await first.adapter.dispatch("opencraft/thread-pins/list", {}), { supported: true, data: [] });
    await assert.rejects(first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "", pinned: true }));
    await assert.rejects(first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "s1", pinned: "yes" }));
    await assert.rejects(first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "missing", pinned: true }), /Unknown DSH session/);
    await first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "s2", pinned: true });
    await first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "s1", pinned: true });
    await first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "blank", pinned: true });
    let page = await first.adapter.dispatch("opencraft/thread-pins/list", {}) as any;
    assert.deepEqual(page.data.map((row: any) => row.id), ["s2", "s1"]);
    await first.adapter.dispatch("opencraft/thread-pins/set", { threadId: "s2", pinned: false });
    page = await first.adapter.dispatch("opencraft/thread-pins/list", {}) as any;
    assert.deepEqual(page.data.map((row: any) => row.id), ["s1"]);
    assert.equal(calls.filter(method => method === "host.describe").length, 1);
    assert.equal(calls.some(method => ["session.history", "session.prompt", "session.create"].includes(method)), false);
  } finally { first.adapter.close(); }
  const stored = JSON.parse(await readFile(join(home, "thread-pins.json"), "utf8"));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.threadIds.filter((id: string) => id !== "blank"), ["s1"]);
  const second = await open();
  try {
    const page = await second.adapter.dispatch("opencraft/thread-pins/list", {}) as any;
    assert.deepEqual(page.data.map((row: any) => row.id), ["s1"]);
    await second.adapter.dispatch("opencraft/thread-pins/set", { threadId: "s2", pinned: true });
    const reordered = await second.adapter.dispatch("opencraft/thread-pins/list", {}) as any;
    assert.deepEqual(reordered.data.map((row: any) => row.id), ["s1", "s2"]);
  } finally { second.adapter.close(); await rm(home, { recursive: true, force: true }); }
});


test("Pi advertises and persists pins without opening a durable session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-pins-"));
  const one = "pi_11111111-1111-4111-8111-111111111111";
  const two = "pi_22222222-2222-4222-8222-222222222222";
  const temporary = "pi_33333333-3333-4333-8333-333333333333";
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    format: "pi-durable-1", id, cwd: directory, model: "pi:faux:one", name: null, preview: `Chat ${id}`,
    createdAt: 1, updatedAt: 1, archived: false, tools: [], ...extra,
  });
  await writeFile(join(directory, `${one}.json`), JSON.stringify(record(one)));
  await writeFile(join(directory, `${two}.json`), JSON.stringify(record(two)));
  await writeFile(join(directory, `${temporary}.json`), JSON.stringify(record(temporary, { ephemeral: true })));
  const owner = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
  const engine = new PiEngine({ directory, cwd: directory, models: {} as any });
  try {
    assert.equal(engine.extensions["opencraft/thread-lifecycle"].pin, true);
    assert.deepEqual(await engine.request("opencraft/thread-pins/list", {}, owner), { supported: true, data: [] });
    await assert.rejects(engine.request("opencraft/thread-pins/set", { threadId: temporary, pinned: true }, owner), /Temporary/);
    await assert.rejects(engine.request("opencraft/thread-pins/set", { threadId: "", pinned: true }, owner));
    await assert.rejects(engine.request("opencraft/thread-pins/set", { threadId: one, pinned: 1 }, owner));
    await engine.request("opencraft/thread-pins/set", { threadId: two, pinned: true }, owner);
    await engine.request("opencraft/thread-pins/set", { threadId: one, pinned: true }, owner);
    assert.deepEqual((await engine.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id), [two, one]);
  } finally { await engine.close(); }
  const reopened = new PiEngine({ directory, cwd: directory, models: {} as any });
  try {
    assert.deepEqual((await reopened.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id), [two, one]);
    await reopened.request("opencraft/thread-pins/set", { threadId: one, pinned: false }, owner);
    assert.deepEqual((await reopened.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id), [two]);
  } finally { await reopened.close(); await rm(directory, { recursive: true, force: true }); }
});


async function legacyPinBackend(thread: Record<string, unknown>) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const state = { pinned: false };
  sockets.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(String(data)) as { id?: number; method?: string; params?: Record<string, any> };
    if (frame.id === undefined || frame.method === undefined) return;
    let result: unknown;
    switch (frame.method) {
      case "initialize": result = { codexHome: "/tmp", capabilities: { extensions: {
        "opencraft/thread-lifecycle": { version: 1, rename: true, archive: true, pin: true },
        "opencraft/thread-pins": { version: 1 },
      } } }; break;
      case "thread/list": result = { data: [thread], nextCursor: null }; break;
      case "opencraft/thread-pins/list": result = { supported: true, data: state.pinned ? [thread] : [] }; break;
      case "opencraft/thread-pins/set": state.pinned = frame.params?.pinned === true; result = { pinned: state.pinned }; break;
      default: result = {};
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result, [LOGICAL_CLIENT_FIELD]: frame[LOGICAL_CLIENT_FIELD] }));
  }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    state,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}


test("engine host advertises and routes pins for DSH and Pi without opening either", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-engine-pins-"));
  const piDirectory = join(root, "pi");
  const piThread = "pi_44444444-4444-4444-8444-444444444444";
  const legacyThread = { id: "dsh-thread", name: "DSH chat", preview: "DSH chat", cwd: "/tmp", createdAt: 1, updatedAt: 1_788_000_000_000, modelProvider: "dsh", status: { type: "idle" }, turns: [] };
  const legacy = await legacyPinBackend(legacyThread);
  const piRecord = (id: string, updatedAt: number) => ({
    format: "pi-durable-1", id, cwd: piDirectory, model: "pi:faux:one", name: `Pi ${id}`, preview: `Pi ${id}`,
    createdAt: 1, updatedAt, archived: false, tools: [],
  });
  await mkdir(piDirectory);
  await writeFile(join(piDirectory, `${piThread}.json`), JSON.stringify(piRecord(piThread, 1_788_000_000_100)));
  const startLegacy = async () => ({ websocketUrl: legacy.url, async close() {} });
  let host: Awaited<ReturnType<typeof startEngineHost>> | undefined;
  let runtime: ReturnType<typeof createAppServerWorkbenchRuntime> | undefined;
  const connectRuntime = async () => {
    runtime = createAppServerWorkbenchRuntime({ hostId: "engine-host-pins", autoReconnect: false,
      createTransport: () => new WebSocketTransport(host!.websocketUrl) });
    await runtime.connect();
    return runtime;
  };
  try {
    host = await startEngineHost({ providers: [new PiEngine({ directory: piDirectory, cwd: piDirectory, models: {} as any })],
      defaultEngine: "dsh", legacy: { id: "dsh", label: "DSH", start: startLegacy } });
    let current = await connectRuntime();
    let page = await current.resources.threads.list();
    assert.deepEqual(page.data.map(row => row.id).sort(), ["dsh-thread", piThread]);
    assert.equal(current.resources.threads.capabilities!("dsh-thread").pin, true);
    assert.equal(current.resources.threads.capabilities!(piThread).pin, true);
    await current.resources.threads.setPinned!("dsh-thread", true);
    await current.resources.threads.setPinned!(piThread, true);
    page = await current.resources.threads.list();
    assert.deepEqual(page.data.filter(row => row.pinned === true).map(row => row.id).sort(), ["dsh-thread", piThread]);
    assert.equal(legacy.state.pinned, true);
    assert.equal(JSON.parse(await readFile(join(piDirectory, `${piThread}.json`), "utf8")).pinned, true);
    await current.resources.threads.setPinned!(piThread, false);
    page = await current.resources.threads.list();
    assert.deepEqual(page.data.filter(row => row.pinned === true).map(row => row.id), ["dsh-thread"]);
    await current.resources.threads.setPinned!(piThread, true);
    await current.dispose();
    runtime = undefined;
    await host.close();
    host = undefined;

    host = await startEngineHost({ providers: [new PiEngine({ directory: piDirectory, cwd: piDirectory, models: {} as any })],
      defaultEngine: "dsh", legacy: { id: "dsh", label: "DSH", start: startLegacy } });
    current = await connectRuntime();
    page = await current.resources.threads.list();
    assert.deepEqual(page.data.filter(row => row.pinned === true).map(row => row.id).sort(), ["dsh-thread", piThread]);
  } finally {
    await runtime?.dispose();
    await host?.close();
    await legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});
