import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient, AppServerClientError } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime, type HydratedThreadHistory } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const aborted = (error: unknown) => error instanceof AppServerClientError && error.code === "ABORTED";
function turn(tag: string) { return { id: `turn-${tag}`, status: "completed", itemsView: "full", items: [{ id: `item-${tag}`, type: "agentMessage", text: tag }], error: null }; }
function response(id: string, tag: string) {
  return { thread: { id, sessionId: id, name: id, path: `/rollouts/${id}`, cwd: "/workspace", historyMode: "message-window", turns: [] },
    model: "fixture", modelProvider: "fixture", cwd: "/workspace", runtimeWorkspaceRoots: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {},
    initialTurnsPage: { data: [turn(tag)], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
}
async function harness(options: { hold?: string; ignoreCancellation?: boolean; hint?: "message-window" | null; drain?: boolean } = {}) {
  const gates: (() => void)[] = [], calls: string[] = [];
  const counts = new Map<string, number>();
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    calls.push(request.method);
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "cancel-fixture",
      capabilities: { extensions: { "opencraft/read-history": { version: 1 }, "opencraft/resume-history": { version: 1, mode: "message-window" } } } }); return; }
    const id = (request.params as { threadId?: string }).threadId ?? "a";
    const key = `${id}:${request.method}`, count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    const reply = () => send(response(id, `${id}-${count}`));
    if (request.method === options.hold && count === 1 && id === "a") gates.push(reply);
    else reply();
  } });
  const client = new JsonRpcAppServerClient({ hostId: "history-cancel", transport });
  await client.connect({ clientInfo: { name: "cancel-test", version: "1" }, capabilities: {} });
  if (options.ignoreCancellation) {
    const request = client.request.bind(client);
    client.request = ((method, params, requestOptions) => request(method, params, { ...requestOptions, signal: undefined })) as typeof client.request;
  }
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: options.hint === undefined ? "message-window" : options.hint, requestTimeoutMs: 60_000, drainTailHistory: options.drain });
  return { client, transport, session, gates, calls, counts, async close() { for (const reply of gates) reply(); await session.dispose(); await client.close(); } };
}

for (const kind of ["read", "resume"] as const) for (const ignoreCancellation of [false, true]) {
  test(`${kind} revokes its slot before an ${ignoreCancellation ? "uncooperative" : "cooperative"} RPC returns`, async () => {
    const h = await harness({ hold: `thread/${kind}`, ignoreCancellation });
    const controller = new AbortController();
    try {
      const pending = kind === "read" ? h.session.resume.read("a", { signal: controller.signal }) : h.session.resume.resume({ threadId: "a", signal: controller.signal });
      const rejected = assert.rejects(pending, aborted);
      for (let i = 0; i < 10 && h.gates.length === 0; i++) await flush(); assert.equal(h.gates.length, 1);
      await h.session.resume.read("b");
      controller.abort(); await rejected;
      const fresh = kind === "read" ? await h.session.resume.read("a") : await h.session.resume.resume({ threadId: "a", force: true });
      assert.match(JSON.stringify(fresh.turns), /a-2/);
      h.gates[0]!(); for (let i = 0; i < 3; i++) await flush();
      assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-2/);
      assert.doesNotMatch(JSON.stringify(h.session.views.get("a")?.turns), /a-1/);
      assert.match(JSON.stringify(h.session.views.get("b")?.turns), /b-1/);
      assert.equal(h.calls.includes("turn/start"), false);
    } finally { await h.close(); }
  });
}

test("Resume cancels preflight Read without issuing a retired Resume", async () => {
  const h = await harness({ hold: "thread/read", ignoreCancellation: true, hint: null });
  const controller = new AbortController();
  try {
    const pending = h.session.resume.resume({ threadId: "a", signal: controller.signal });
    const rejected = assert.rejects(pending, aborted);
    for (let i = 0; i < 10 && h.gates.length === 0; i++) await flush(); assert.equal(h.gates.length, 1);
    controller.abort(); await rejected;
    await h.session.resume.resume({ threadId: "a", force: true });
    const resumes = h.calls.filter(method => method === "thread/resume").length;
    h.gates[0]!(); for (let i = 0; i < 3; i++) await flush();
    assert.equal(resumes, 1); assert.equal(h.calls.filter(method => method === "thread/resume").length, 1);
    assert.equal(h.session.views.get("a")?.resumeState, "resumed");
  } finally { await h.close(); }
});

for (const lateFailure of [false, true]) test(`ignored strategy cancellation fences its late ${lateFailure ? "failure" : "success"} and cleanup`, async () => {
  const h = await harness(); const controller = new AbortController();
  let release!: (value: HydratedThreadHistory) => void, reject!: (error: Error) => void, entered = 0;
  const history: HydratedThreadHistory = { source: "message-window", turns: [], complete: true, olderCursor: null, itemsPaginationByTurnId: {} };
  const remove = h.session.historyStrategies.register({ name: "fork", priority: 1000, matches: () => true,
    load: async () => { entered++; return new Promise<HydratedThreadHistory>((done, fail) => { release = done; reject = fail; }); } });
  try {
    const pending = h.session.resume.resume({ threadId: "a", signal: controller.signal });
    const rejected = assert.rejects(pending, aborted);
    for (let i = 0; i < 10 && entered === 0; i++) await flush(); assert.equal(entered, 1);
    controller.abort(); await rejected; remove();
    const fresh = await h.session.resume.resume({ threadId: "a", force: true });
    assert.match(JSON.stringify(fresh.turns), /a-2/);
    h.session.context.resumeNotificationBuffer.begin("a");
    if (lateFailure) reject(new Error("retired strategy failure")); else release(history);
    for (let i = 0; i < 3; i++) await flush();
    assert.equal(h.session.context.resumeNotificationBuffer.isBuffering("a"), true, "old cleanup must not discard/release a successor buffer");
    assert.equal(h.session.views.get("a")?.resumeState, "resumed");
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-2/);
    assert.equal(h.session.views.get("a")?.resumeError, null);
  } finally { release?.(history); remove(); await h.close(); }
});

test("an earlier abort listener can acquire a successor before the coordinator's abort listener runs", async () => {
  const h = await harness({ hold: "thread/read", ignoreCancellation: true }); const controller = new AbortController();
  let successor: Promise<unknown> | undefined;
  controller.signal.addEventListener("abort", () => { successor = h.session.resume.read("a"); });
  try {
    const old = h.session.resume.read("a", { signal: controller.signal }); const rejected = assert.rejects(old, aborted);
    for (let i = 0; i < 10 && h.gates.length === 0; i++) await flush(); assert.equal(h.gates.length, 1);
    controller.abort(); await rejected; await successor;
    assert.equal(h.counts.get("a:thread/read"), 2);
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-2/);
  } finally { await h.close(); }
});

test("preaborted callers cannot join a live owner; cancellation after success leaves its baseline intact", async () => {
  const h = await harness({ hold: "thread/read" }); const controller = new AbortController(); controller.abort();
  try {
    const pending = h.session.resume.read("a");
    await assert.rejects(h.session.resume.read("a", { signal: controller.signal }), aborted);
    await assert.rejects(h.session.resume.resume({ threadId: "a", signal: controller.signal }), aborted);
    for (let i = 0; i < 10 && h.gates.length === 0; i++) await flush(); h.gates[0]!(); await pending;
    const later = new AbortController(); await h.session.resume.read("a", { signal: later.signal }); later.abort();
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-2/);
  } finally { await h.close(); }
});

test("Session disposal settles a strategy wait without waiting for the strategy", async () => {
  const h = await harness(); let release!: (value: HydratedThreadHistory) => void, entered = false;
  h.session.historyStrategies.register({ name: "fork", priority: 1000, matches: () => true, load: () => {
    entered = true; return new Promise<HydratedThreadHistory>(done => { release = done; });
  } });
  try {
    const pending = h.session.resume.resume({ threadId: "a" }); const rejected = assert.rejects(pending, aborted);
    for (let i = 0; i < 10 && !entered; i++) await flush(); assert.equal(entered, true);
    await h.session.dispose(); await rejected;
  } finally { release?.({ source: "message-window", turns: [], complete: true, olderCursor: null, itemsPaginationByTurnId: {} }); await h.client.close(); }
});

for (const joining of ["read", "resume"] as const) test(`joining ${joining} cancels only its own wait while the initiating Read continues`, async () => {
  const h = await harness({ hold: "thread/read" }); const controller = new AbortController();
  try {
    const first = h.session.resume.read("a");
    const second = joining === "read" ? h.session.resume.read("a", { signal: controller.signal })
      : h.session.resume.resume({ threadId: "a", signal: controller.signal });
    const rejected = assert.rejects(second, aborted); controller.abort(); await rejected;
    for (let i = 0; i < 10 && h.gates.length === 0; i++) await flush();
    assert.equal(h.counts.get("a:thread/read"), 1); h.gates[0]!(); await first;
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-1/);
    assert.equal(h.calls.includes("thread/resume"), false);
  } finally { await h.close(); }
});

for (const older of [false, true]) test(`fresh Read retires an old Resume ${older ? "pagination" : "background drain"} in the same client generation`, async () => {
  const h = await harness({ drain: !older });
  let release!: (value: HydratedThreadHistory) => void, releaseDrain!: (turns: HydratedThreadHistory["turns"]) => void;
  const oldHistory: HydratedThreadHistory = { source: "tail", turns: [], complete: false, olderCursor: "old-cursor", itemsPaginationByTurnId: {},
    ...(!older ? { drainRemaining: () => new Promise(done => { releaseDrain = done; }) } : {}) };
  h.session.historyStrategies.register({ name: "fork", priority: 1000, matches: () => true, load: async () => oldHistory,
    loadOlder: () => new Promise(done => { release = done; }) });
  try {
    await h.session.resume.resume({ threadId: "a" });
    const pending = older ? h.session.resume.loadOlder("a").catch(error => { assert.equal(aborted(error), true); }) : h.session.resume.waitForBackgroundHistory("a");
    await flush();
    await h.session.resume.read("a");
    const stale = { id: "retired-turn", status: "completed", items: [{ id: "retired-item", type: "agentMessage", text: "retired-older-body" }] };
    if (older) release({ ...oldHistory, turns: [stale] }); else releaseDrain([stale]);
    await pending;
    assert.doesNotMatch(JSON.stringify(h.session.views.get("a")?.turns), /retired-older-body/);
    assert.match(JSON.stringify(h.session.views.get("a")?.turns), /a-1/);
  } finally {
    release?.({ ...oldHistory, turns: [] }); releaseDrain?.([]); await h.close();
  }
});


test("client transmits cancellation only for advertised Host history with an opaque read identity", async () => {
  const frames: any[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    frames.push(request);
    if (request.method === "initialize") peer.send(encodeJsonRpcMessage({ id: request.id, result: {
      capabilities: { extensions: { "opencraft/read-history": { version: 1, cancellation: true } } },
    } }));
    if (request.method === "thread/history/cancel") peer.send(encodeJsonRpcMessage({ id: request.id, result: { cancelled: true } }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "cancel-wire", transport });
  try {
    await client.connect({ clientInfo: { name: "test", version: "1" } });
    const controller = new AbortController();
    const reading = client.request("thread/read", { threadId: "thread", includeTurns: false, initialTurnsPage: { limit: 10 } }, { signal: controller.signal });
    const rejected = assert.rejects(reading, aborted);
    await flush(); controller.abort(); await rejected; await flush();
    const read = frames.find(f => f.method === "thread/read"), cancel = frames.find(f => f.method === "thread/history/cancel");
    assert.ok(typeof read.params.historyReadId === "string");
    assert.deepEqual(cancel.params, { threadId: "thread", historyReadId: read.params.historyReadId });
    assert.equal(frames.some(f => f.method === "turn/interrupt" || f.method === "thread/unsubscribe"), false);
  } finally { await client.close(); }
});
