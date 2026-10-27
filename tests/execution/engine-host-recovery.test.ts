import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import { ThreadLifecycle } from "../../apps/local-agent-host/src/thread-lifecycle.js";
import { ThreadCatalog } from "../../apps/local-agent-host/src/thread-catalog.js";
import { createAppServerWorkbenchRuntime } from "../../packages/workbench-runtime/src/appserver-runtime.js";
import { WebSocketTransport } from "../../packages/appserver-transport-websocket/src/websocket-transport.js";
import { LOGICAL_CLIENT_FIELD } from "../../packages/app-host-protocol/src/index.js";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Recovery did not reach the expected state");
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: test.TestContext, proxy = false) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const thread = { id: "dsh-recovery", name: "Recovery", createdAt: 1, updatedAt: 1, cwd: "/tmp", source: "cli", preview: "", modelProvider: "dsh", status: { type: "idle" }, turns: [] };
  const lifecycle = new ThreadLifecycle(new ThreadCatalog(), async () => ({ released: true }), () => {});
  const connections: { socket: WebSocket; key: string; clientId: string }[] = [];
  const calls: { key: string; method: string; params: any }[] = [];
  let beforeRequest: ((method: string) => Promise<void>) | undefined;
  sockets.on("connection", socket => {
    const state = { socket, key: `physical-${connections.length + 1}`, clientId: "" }; connections.push(state);
    socket.on("message", async data => {
      const frame = JSON.parse(String(data)); state.clientId = frame[LOGICAL_CLIENT_FIELD] ?? "";
      if (frame.id === undefined) return;
      calls.push({ key: state.key, method: frame.method, params: frame.params });
      try {
        await beforeRequest?.(frame.method);
        const result = await lifecycle.dispatch(frame.method, frame.params ?? {}, state.key, async method => {
          if (method === "initialize") return { userAgent: "recovery-fixture", platformFamily: "unix", platformOs: "linux" };
          if (["thread/resume", "thread/read"].includes(method)) return { thread, model: "dsh", modelProvider: "dsh", cwd: "/tmp", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, runtimeWorkspaceRoots: [] };
          if (method === "turn/start") return { turn: { id: "accepted-once", status: "inProgress", items: [] } };
          if (method === "skills/list") return { data: [{ cwd: "/tmp", skills: [{ name: "dsh-only" }], errors: [] }] };
          if (["thread/list", "model/list", "thread/turns/list", "thread/items/list", "permissionProfile/list"].includes(method)) return { data: [], nextCursor: null };
          return {};
        });
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result, [LOGICAL_CLIENT_FIELD]: state.clientId }));
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: String(error) }, [LOGICAL_CLIENT_FIELD]: state.clientId }));
      }
    });
    socket.on("close", () => { lifecycle.revokeClient(state.key); void lifecycle.disconnect(state.key); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const target = `ws://127.0.0.1:${(server.address() as any).port}`;
  let providerClosed = 0, providerDisconnected = 0;
  const provider: any = { id: "pi", label: "Pi", threadPrefix: "pi_", modelPrefix: "pi:", extensions: {}, ownsThread: (id: string) => id.startsWith("pi_"), ownsModel: (id: string) => id.startsWith("pi:"), subscribe: () => () => {}, disconnect() { providerDisconnected++; }, async close() { providerClosed++; }, async request(method: string) { return method === "skills/list" ? { data: [{ cwd: "/tmp", skills: [{ name: "pi-only" }], errors: [] }] } : { data: [], nextCursor: null }; } };
  let resolveTarget = async () => target;
  const host = await startEngineHost({ providers: [provider], defaultEngine: "dsh", legacy: { id: "dsh", label: "DSH", start: async () => ({ websocketUrl: target, resolveWebsocketUrl: () => resolveTarget(), async close() {} }) } });
  let url = host.websocketUrl, web: any, root: string | undefined;
  if (proxy) {
    root = await mkdtemp(join(tmpdir(), "engine-host-recovery-"));
    await writeFile(join(root, "index.html"), "<!doctype html><html><head></head><body>Recovery fixture</body></html>");
    web = await createWorkbenchWebServer({ root, appServerTarget: url });
    const address = await web.listen({ host: "127.0.0.1", port: 0 }); url = `ws://127.0.0.1:${address.port}/appserver`;
  }
  let client: any;
  const notifications: any[] = [], phases: string[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "recovery-fixture", autoReconnect: true, reconnectDelaysMs: [1],
    createTransport: () => new WebSocketTransport({ url, createSocket: (url, protocols) => new WebSocket(url, protocols) as any }),
    installClientHandlers(value) { client = value; return value.subscribeNotification(notification => notifications.push(notification)); },
  });
  runtime.subscribe(() => phases.push(runtime.getSnapshot().phase));
  t.after(async () => { await runtime.dispose(); await web?.close(); await host.close(); for (const state of connections) state.socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await lifecycle.close(); if (root) await rm(root, { recursive: true, force: true }); });
  return { runtime, connections, calls, notifications, phases, host, thread, lifecycle, target,
    get client() { return client; }, get providerClosed() { return providerClosed; }, get providerDisconnected() { return providerDisconnected; },
    beforeRequest(value: typeof beforeRequest) { beforeRequest = value; }, resolveTarget(value: typeof resolveTarget) { resolveTarget = value; },
    emit(delta: string) { for (const state of connections) if (state.socket.readyState === WebSocket.OPEN && lifecycle.receivesNotifications(state.key, thread.id)) state.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn", itemId: "item", delta }, [LOGICAL_CLIENT_FIELD]: state.clientId })); },
  };
}

for (const proxy of [false, true]) test(`backend loss restores the actual Thread subscription automatically (${proxy ? "HTTP gateway" : "direct"})`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, proxy); await f.runtime.connect();
  const lease = await f.runtime.acquireThread(f.thread.id); lease.setRecoveryVisibility(true);
  await until(() => lease.getSnapshot().authoritative);
  await f.client.request("turn/start", { threadId: f.thread.id, input: [{ type: "text", text: "synthetic" }] });
  let sawRevocation = false;
  const unsubscribe = lease.subscribe(() => { if (!lease.getSnapshot().authoritative) sawRevocation = true; });
  t.after(unsubscribe);
  for (let cycle = 0; cycle < 3; cycle++) {
    const old = f.connections.at(-1)!, count = f.connections.length;
    f.emit(`before-${cycle}`); await until(() => f.notifications.some(n => n.params?.delta === `before-${cycle}`));
    old.socket.close(1012, "Synthetic independent Host restart");
    await until(() => f.connections.length > count && lease.getSnapshot().authoritative && f.lifecycle.receivesNotifications(f.connections.at(-1)!.key, f.thread.id));
    f.emit(`after-${cycle}`); await until(() => f.notifications.some(n => n.params?.delta === `after-${cycle}`));
    const methods = f.calls.filter(call => call.key === f.connections.at(-1)!.key).map(call => call.method);
    assert.ok(methods.includes("initialize")); assert.ok(methods.includes("thread/resume"));
  }
  assert.equal(sawRevocation, true); assert.ok(f.phases.includes("reconnecting"));
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1, "Recovery must not replay an accepted execution");
  assert.equal(f.providerClosed, 0, "Client recovery must not close the engine owner");
  assert.ok(f.providerDisconnected >= 3, "The shared Host connection also retires its Pi client leases");
  await lease.release();
});

test("a configured DSH initialization error cannot become a successful Pi handshake", { timeout: 15_000 }, async t => {
  const f = await fixture(t); let fail = true;
  f.beforeRequest(async method => { if (method === "initialize" && fail) throw new Error("Temporary DSH initialization failure"); });
  await assert.rejects(f.runtime.connect());
  assert.notEqual(f.runtime.getSnapshot().phase, "ready");
  fail = false; await until(() => f.runtime.getSnapshot().phase === "ready");
  assert.ok(f.calls.filter(call => call.method === "initialize").length >= 2);
});

test("loss during Resume rejects the old restoration and a late result cannot replace its successor", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await f.runtime.connect(); const gate = deferred(); let first = true;
  f.beforeRequest(async method => { if (method === "thread/resume" && first) { first = false; await gate.promise; } });
  const lease = await f.runtime.acquireThread(f.thread.id); lease.setRecoveryVisibility(true);
  await until(() => !first); f.connections[0]!.socket.close(1012, "Loss during Resume");
  await until(() => f.connections.length === 2 && lease.getSnapshot().authoritative);
  gate.resolve(); await flush();
  assert.equal(f.runtime.getSnapshot().phase, "ready"); assert.equal(lease.getSnapshot().authoritative, true);
  f.emit("successor"); await until(() => f.notifications.some(n => n.params?.delta === "successor"));
  assert.equal(f.connections.length, 2); await lease.release();
});

test("a late backend target cannot allocate a socket after the frontend incarnation was retired", { timeout: 15_000 }, async t => {
  const f = await fixture(t), gate = deferred(); let first = true;
  f.resolveTarget(async () => { if (first) { first = false; await gate.promise; } return f.target; });
  const socket = new WebSocket(f.host.websocketUrl); await once(socket, "open");
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await until(() => !first); const closed = once(socket, "close"); socket.terminate(); await closed; await flush();
  await f.runtime.connect(); assert.equal(f.runtime.getSnapshot().phase, "ready");
  gate.resolve(); await flush();
  assert.equal(f.connections.length, 1); assert.equal(f.runtime.getSnapshot().phase, "ready");
});

test("logical clients on one connection share identical initialize and thread/list reads", async () => {
  const backend = createServer();
  const backendSockets = new WebSocketServer({ server: backend });
  const calls = new Map<string, number>();
  backendSockets.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(String(data));
    if (typeof frame.id === "undefined") return;
    calls.set(frame.method, (calls.get(frame.method) ?? 0) + 1);
    const result = frame.method === "initialize"
      ? { userAgent: "singleflight-fixture", platformFamily: "unix", platformOs: "linux" }
      : frame.method === "thread/list" ? { data: [], nextCursor: null } : {};
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    }, 50);
  }));
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const target = `ws://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const host = await startEngineHost({ providers: [], defaultEngine: "dsh",
    legacy: { id: "dsh", label: "DSH", start: async () => ({ websocketUrl: target, async close() {} }) } });
  const clients = [new WebSocket(host.websocketUrl)];
  const pending = new Map<string, (value: any) => void>();
  const send = (clientId: string, socket: WebSocket, id: string, method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>(resolve => {
      pending.set(`${clientId}:${id}`, resolve);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    });
  try {
    await Promise.all(clients.map(socket => new Promise<void>(resolve => socket.once("open", () => resolve()))));
    for (const socket of clients) socket.on("message", data => {
      const frame = JSON.parse(String(data));
      if (frame.id !== undefined) pending.get(`${frame[LOGICAL_CLIENT_FIELD]}:${frame.id}`)?.(frame);
    });
    const initialized = await Promise.all(["a", "b"].map(clientId => send(clientId, clients[0]!, "init", "initialize", { clientInfo: { name: "burst", version: "1" } })));
    assert.deepEqual(initialized.map(frame => frame.result.userAgent), ["singleflight-fixture", "singleflight-fixture"]);
    assert.equal(calls.get("initialize"), 1);
    const catalogs = await Promise.all(["a", "b"].map(clientId => send(clientId, clients[0]!, "list", "thread/list", { limit: 50 })));
    assert.deepEqual(catalogs.map(frame => frame.result), [{ data: [], nextCursor: null, unavailableEngines: [] }, { data: [], nextCursor: null, unavailableEngines: [] }]);
    assert.equal(calls.get("thread/list"), 1);
  } finally {
    for (const socket of clients) socket.terminate();
    await host.close();
    backendSockets.close();
    await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});


for (const method of ["initialize", "thread/list", "model/list"]) test(`closing one frontend cannot cancel another frontend's pending ${method}`, { timeout: 10_000 }, async () => {
  const backend = createServer();
  const backendSockets = new WebSocketServer({ server: backend });
  const gate = deferred();
  let calls = 0;
  backendSockets.on("connection", socket => socket.on("message", async data => {
    const frame = JSON.parse(String(data));
    if (frame.id === undefined) return;
    if (frame.method === method) { calls++; await gate.promise; }
    const result = frame.method === "initialize"
      ? { userAgent: "ownership-fixture", platformFamily: "unix", platformOs: "linux" }
      : { data: [], nextCursor: null };
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  }));
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const target = `ws://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const host = await startEngineHost({ providers: [], defaultEngine: "dsh",
    legacy: { id: "dsh", label: "DSH", start: async () => ({ websocketUrl: target, async close() {} }) } });
  const clients = [new WebSocket(host.websocketUrl), new WebSocket(host.websocketUrl)];
  const pending = new Map<string, (frame: any) => void>();
  const send = (socket: WebSocket, id: string, requestMethod: string) => new Promise<any>(resolve => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: {} }));
  });
  try {
    await Promise.all(clients.map(socket => once(socket, "open")));
    for (const socket of clients) socket.on("message", data => {
      const frame = JSON.parse(String(data));
      const resolve = pending.get(frame.id); pending.delete(frame.id); resolve?.(frame);
    });
    void send(clients[0]!, "origin", method);
    await until(() => calls === 1);
    const surviving = send(clients[1]!, "survivor", method);
    // The following frame confirms the survivor has entered its pending read.
    await send(clients[1]!, "barrier", "runtime/engines/list");
    const closed = once(clients[0]!, "close"); clients[0]!.terminate(); await closed;
    await flush(); gate.resolve();
    const reply = await surviving;
    assert.equal(reply.error, undefined, "An unrelated frontend's teardown must not reject this read");
    assert.ok(reply.result);
    assert.equal(calls, 2, "Each independently cancelable connection must own its backend read");
    assert.equal((await send(clients[1]!, "next", method)).error, undefined);
    assert.equal(calls, 3, "Completed reads must leave no stale in-flight entry");
  } finally {
    gate.resolve();
    for (const socket of clients) socket.terminate();
    await host.close();
    for (const socket of backendSockets.clients) socket.terminate();
    await new Promise<void>(resolve => backendSockets.close(() => resolve()));
    await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});


test("legacy forwarding preserves typed archive, missing and retryable RPC failures", async () => {
  const server = createServer(), sockets = new WebSocketServer({ server });
  const failures = [
    { code: -32071, message: "Archived", data: { code: "THREAD_ARCHIVED", retryable: false } },
    { code: -32004, message: "Missing", data: { code: "THREAD_NOT_FOUND", retryable: false } },
    { code: -32070, message: "Bridge warming up", data: { code: "DSH_RESTARTING", retryable: true } },
  ];
  sockets.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(String(data));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: failures[frame.params.index] }));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const target = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = await startEngineHost({ providers: [], defaultEngine: "dsh",
    legacy: { id: "dsh", label: "DSH", start: async () => ({ websocketUrl: target, async close() {} }) } });
  const socket = new WebSocket(host.websocketUrl); await once(socket, "open");
  try {
    for (let index = 0; index < failures.length; index++) {
      const response = once(socket, "message");
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: index, method: "thread/resume", params: { threadId: "dsh-thread", index }, [LOGICAL_CLIENT_FIELD]: "logical" }));
      const frame = JSON.parse(String((await response)[0]));
      assert.equal(frame.id, index); assert.equal(frame[LOGICAL_CLIENT_FIELD], "logical"); assert.deepEqual(frame.error, failures[index]);
    }
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    socket.terminate(); await host.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Skill catalogs follow draft models and immutable thread owners without leaking scope to legacy Hosts", async t => {
  const f = await fixture(t); await f.runtime.connect();
  const catalog = f.runtime.resources.composerCatalog;
  const names = async (scope: any) => (await catalog.listSkills({ cwds: ["/tmp"], ...scope })).data.flatMap(group => group.skills.map(skill => skill.name));
  assert.deepEqual(await names({}), ["dsh-only"]);
  assert.deepEqual(await names({ model: "pi:faux" }), ["pi-only"]);
  assert.deepEqual(await names({ threadId: "pi_existing", model: "dsh" }), ["pi-only"]);
  assert.deepEqual(await names({ threadId: f.thread.id, model: "pi:faux" }), ["dsh-only"]);
  assert.deepEqual(await names({ model: "dsh" }), ["dsh-only"]);
  const legacy = f.calls.filter(call => call.method === "skills/list");
  assert.equal(legacy.length, 3);
  for (const call of legacy) assert.deepEqual(call.params, { cwds: ["/tmp"] });
  await assert.rejects(names({ threadId: 42 }), /Invalid Skill catalog target/);
});
