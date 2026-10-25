import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClientError, JsonRpcAppServerClient, type AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const initialized = { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "elapsed-budget" };
function clocks() {
  let wall = 1_000_000, elapsed = 0;
  const dateNow = Date.now, descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  Date.now = () => wall;
  Object.defineProperty(performance, "now", { configurable: true, value: () => elapsed });
  return { advance(wallValue: number, elapsedValue: number) { wall = wallValue; elapsed = elapsedValue; },
    restore() { Date.now = dateNow; if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as unknown as { now?: unknown }).now; } };
}

for (const wall of [0, 2_000_000]) test(`default context preparation budget ignores wall jump to ${wall}`, async () => {
  let peer: InMemoryAppServerPeer | undefined;
  const transport = new MemoryTransport({ receive(frame, current) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    peer = current;
    if (request.method === "initialize") current.send(encodeJsonRpcMessage({ id: request.id, result: initialized }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "elapsed-context", transport, requestTimeoutMs: 1000 });
  await client.connect({ clientInfo: { name: "elapsed-test", version: "1" } });
  const clock = clocks(), nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const timers = new Map<number, { delay: number; run(): void }>(); let sequence = 0;
  globalThis.setTimeout = ((run: () => void, delay = 0) => { const id = ++sequence; timers.set(id, { run, delay }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const events: AppServerRequestLifecycleEvent[] = []; client.subscribeRequestLifecycle(event => events.push(event));
  let pending: Promise<unknown> | undefined;
  try {
    pending = client.request("turn/start", { threadId: "a", input: [] }).catch(() => undefined);
    await flush(); assert.ok(peer); assert.equal(timers.size, 1);
    clock.advance(wall, 600);
    peer.send(encodeJsonRpcMessage({ method: "item/started", params: { threadId: "a", turnId: "preparing", item: { id: "prep", type: "contextCompaction" } } }));
    await flush();
    const delay = [...timers.values()][0]?.delay;
    assert.ok(delay !== undefined && Math.abs(delay - 179_400) < 1e-6, `the elapsed preparation cap should leave179400ms, received ${delay}`);
    await client.close(); await pending;
    const ended = [...events].reverse().find(event => event.type === "failed" || event.type === "aborted");
    assert.ok(ended && "durationMs" in ended && "endedAtMs" in ended);
    assert.ok(Math.abs(ended.durationMs - 600) < 1e-6); assert.equal(ended.endedAtMs, wall);
    assert.equal(timers.size, 0);
  } finally {
    await client.close(); await pending;
    globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; clock.restore();
  }
});

test("default quiet history read exhausts elapsed budget despite a wall-clock rollback", async () => {
  const clock = clocks(); let reads = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    if (request.method === "initialize") { peer.send(encodeJsonRpcMessage({ id: request.id, result: { ...initialized,
      capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } } })); return; }
    if (request.method !== "thread/read") return;
    reads++; clock.advance(0, reads * 600);
    if (reads <= 3) peer.send(encodeJsonRpcMessage({ method: "item/agentMessage/delta", params: { threadId: "a", turnId: "turn", itemId: "item", delta: "x" } }));
    peer.send(encodeJsonRpcMessage({ id: request.id, result: {
      thread: { id: "a", sessionId: "a", path: "/fixture/history", cwd: "/fixture", historyMode: "paginated", status: { type: "idle" }, turns: [] },
      initialTurnsPage: { data: [{ id: "turn", status: "completed", itemsView: "full", items: [{ id: "item", type: "agentMessage", text: "x".repeat(reads) }] }], nextCursor: null },
    } }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "elapsed-history", transport });
  let session: Awaited<ReturnType<typeof createCordisThreadSessionRuntime>> | undefined;
  try {
    await client.connect({ clientInfo: { name: "elapsed-test", version: "1" } });
    session = await createCordisThreadSessionRuntime({ client, requestTimeoutMs: 1000 });
    await assert.rejects(session.resume.read("a"), error => error instanceof AppServerClientError && error.code === "TIMEOUT");
    assert.equal(reads, 2, "two overlapping 600ms reads exhaust the 1000ms total budget before a third read");
  } finally { await session?.dispose(); await client.close(); clock.restore(); }
});

test("default lifecycle keeps wall timestamps but measures queue and request duration with elapsed time", async () => {
  const clock = clocks(), events: AppServerRequestLifecycleEvent[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    if (request.method === "initialize") peer.send(encodeJsonRpcMessage({ id: request.id, result: initialized }));
    else { clock.advance(0, 100); peer.send(encodeJsonRpcMessage({ id: request.id, result: { data: [], nextCursor: null } })); }
  } });
  const client = new JsonRpcAppServerClient({ hostId: "elapsed-duration", transport });
  try {
    await client.connect({ clientInfo: { name: "elapsed-test", version: "1" } });
    client.subscribeRequestLifecycle(event => { events.push(event); if (event.type === "queued") clock.advance(2_000_000, 50); });
    await client.request("model/list", {});
    const queued = events.find(event => event.type === "queued"), started = events.find(event => event.type === "started"), ended = events.find(event => event.type === "completed");
    assert.ok(queued?.type === "queued" && started?.type === "started" && ended?.type === "completed");
    assert.equal(queued.queuedAtMs, 1_000_000); assert.equal(started.startedAtMs, 2_000_000); assert.equal(ended.endedAtMs, 0);
    assert.ok(Math.abs(started.queueWaitMs - 50) < 1e-6); assert.ok(Math.abs(ended.durationMs - 50) < 1e-6);
  } finally { await client.close(); clock.restore(); }
});

async function heldQuietRead() {
  const clock = clocks(); let elapsed = 0, reads = 0, reply: (() => void) | undefined;
  const timers = new Map<number, { at: number; run(): void }>(); let sequence = 0;
  const thread = { id: "a", sessionId: "a", path: "/fixture/history", cwd: "/fixture", historyMode: "paginated", turns: [] };
  const body = (text: string) => ({ thread, initialTurnsPage: { data: [{ id: "turn", status: "completed", itemsView: "full",
    items: [{ id: "item", type: "agentMessage", text }] }], nextCursor: null } });
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const send = (value: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result: value }));
    if (request.method === "initialize") { send({ ...initialized, capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); return; }
    if (request.method !== "thread/read") return;
    reads++;
    if (reads === 1) {
      elapsed = 900; clock.advance(0, elapsed);
      peer.send(encodeJsonRpcMessage({ method: "item/agentMessage/delta", params: { threadId: "a", turnId: "turn", itemId: "item", delta: "x" } }));
      send(body("initial"));
    } else if (reads === 2) reply = () => send(body("retired-held-body"));
    else send(body("fresh-successor"));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "quiet-total-budget", transport });
  await client.connect({ clientInfo: { name: "quiet-test", version: "1" } });
  // A deliberately uncooperative child cannot retain the local read owner.
  const request = client.request.bind(client);
  client.request = ((method, params, options) => request(method, params, { ...options, signal: undefined })) as typeof client.request;
  const session = await createCordisThreadSessionRuntime({ client, requestTimeoutMs: 1000 });
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, delay = 0) => { const id = ++sequence; timers.set(id, { at: elapsed + delay, run }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  return { session, reads: () => reads, held: () => Boolean(reply), reply: () => reply?.(),
    advance(value: number, callbacks: boolean) {
      elapsed = value; clock.advance(0, elapsed);
      if (callbacks) for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= elapsed) { timers.delete(id); timer.run(); }
    },
    async close() { try { reply?.(); await session.dispose(); await client.close(); } finally { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; clock.restore(); } },
  };
}

for (const probe of [false, true]) test(`quiet reread cap settles locally before held RPC completion (${probe ? "explicit overdue probe" : "due timer"})`, async () => {
  const h = await heldQuietRead(); let settled = false, failure: unknown;
  try {
    const first = h.session.resume.read("a");
    const observed = first.then(() => { settled = true; }, error => { settled = true; failure = error; });
    for (let i = 0; i < 12 && !h.held(); i++) await flush(); assert.equal(h.held(), true);
    h.advance(probe ? 1500 : 1001, !probe);
    const next = probe ? h.session.resume.read("a") : undefined;
    for (let i = 0; i < 6; i++) await flush();
    assert.equal(settled, true, "an in-flight reread cannot outlive its quiet-cut budget");
    assert.equal((failure as { code?: string })?.code, "TIMEOUT"); await observed;
    await (next ?? h.session.resume.read("a")); assert.equal(h.reads(), 3);
    h.reply(); for (let i = 0; i < 4; i++) await flush();
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /fresh-successor/);
    assert.doesNotMatch(JSON.stringify(h.session.views.get("a")?.turns), /retired-held-body/);
  } finally { await h.close(); }
});

test("a history read admitted during child abort keeps precedence over the triggering caller", async () => {
  let reply: (() => void) | undefined, reads = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const send = (value: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result: value }));
    if (request.method === "initialize") { send({ ...initialized, capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); return; }
    const respond = () => send({ thread: { id: "a", sessionId: "a", path: "/fixture/history", cwd: "/fixture", historyMode: "paginated", turns: [] }, initialTurnsPage: { data: [], nextCursor: null } });
    if (++reads === 1) reply = respond; else respond();
  } });
  const client = new JsonRpcAppServerClient({ hostId: "abort-admission", transport });
  await client.connect({ clientInfo: { name: "quiet-test", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client });
  let inner: Promise<unknown> | undefined, outer: Promise<unknown> | undefined, armed = true;
  const request = client.request.bind(client);
  client.request = ((method, params, options) => {
    if (armed && method === "thread/read") {
      armed = false; options?.signal?.addEventListener("abort", () => { inner = session.resume.read("a"); void inner.catch(() => undefined); });
    }
    return request(method, params, options);
  }) as typeof client.request;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { outer = session.resume.read("a"); void outer.catch(() => undefined); });
  try {
    const first = session.resume.read("a", { signal: controller.signal }); const retired = first.catch(() => undefined);
    for (let i = 0; i < 12 && !reply; i++) await flush(); assert.ok(reply);
    controller.abort();
    assert.ok(inner); assert.equal(outer, inner, "post-cancellation admission must recheck the successor installed by child abort");
    await retired; await inner; assert.equal(reads, 2);
  } finally { reply?.(); await session.dispose(); await client.close(); }
});

test("quiet initial pagination retains its existing per-RPC progress budget", async () => {
  const clock = clocks(); let reads = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { send({ ...initialized, capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); return; }
    clock.advance(0, ++reads * 600);
    if (request.method === "thread/read") send({ thread: { id: "a", sessionId: "a", path: "/fixture/history", cwd: "/fixture", historyMode: "paginated", turns: [] },
      initialTurnsPage: { data: [{ id: "turn", status: "completed", itemsView: "notLoaded", items: [] }], nextCursor: null } });
    else send({ data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: "quiet-initial-history" } }], nextCursor: null });
  } });
  const client = new JsonRpcAppServerClient({ hostId: "quiet-initial", transport }); let session: Awaited<ReturnType<typeof createCordisThreadSessionRuntime>> | undefined;
  try {
    await client.connect({ clientInfo: { name: "quiet-test", version: "1" } });
    session = await createCordisThreadSessionRuntime({ client, requestTimeoutMs: 1000 });
    const view = await session.resume.read("a"); assert.equal(reads, 2); assert.match(JSON.stringify(view.turns), /quiet-initial-history/);
  } finally { await session?.dispose(); await client.close(); clock.restore(); }
});

test("an explicit zero timeout leaves the quiet-cut phase cancellable without an automatic deadline", async () => {
  const clock = clocks(); let reads = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    if (request.method === "initialize") { peer.send(encodeJsonRpcMessage({ id: request.id, result: { ...initialized, capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } } })); return; }
    clock.advance(1_000_000, ++reads * 600);
    if (reads === 1) peer.send(encodeJsonRpcMessage({ method: "item/agentMessage/delta", params: { threadId: "a", turnId: "turn", itemId: "item", delta: "x" } }));
    peer.send(encodeJsonRpcMessage({ id: request.id, result: { thread: { id: "a", sessionId: "a", path: "/fixture/history", cwd: "/fixture", historyMode: "paginated", turns: [] }, initialTurnsPage: { data: [], nextCursor: null } } }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "quiet-disabled", transport }); let session: Awaited<ReturnType<typeof createCordisThreadSessionRuntime>> | undefined;
  try {
    await client.connect({ clientInfo: { name: "quiet-test", version: "1" } });
    session = await createCordisThreadSessionRuntime({ client, requestTimeoutMs: 0 });
    await session.resume.read("a"); assert.equal(reads, 2);
  } finally { await session?.dispose(); await client.close(); clock.restore(); }
});
