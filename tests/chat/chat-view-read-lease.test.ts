import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const turn = (tag: string) => ({ id: `turn-${tag}`, status: "completed", itemsView: "full", items: [{ id: `item-${tag}`, type: "agentMessage", text: tag, phase: "final_answer" }], error: null });
async function fixture(maxInactiveThreads = 4) {
  const replies: (() => void)[] = [], methods: string[] = []; let closes = 0;
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    methods.push(request.method); const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "view-read-lease" });
    else if (request.method === "thread/read") {
      const id = (request.params as { threadId: string }).threadId;
      send({ thread: { id, sessionId: id, name: id, path: `/rollouts/${id}`, cwd: "/workspace", historyMode: "paginated", status: { type: "idle" }, turns: [] },
        initialTurnsPage: { data: [turn(`current-${id}`)], nextCursor: "older" }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    } else if (request.method === "thread/turns/list") {
      const index = replies.length; replies.push(() => send({ data: [turn(`older-${index}`)], nextCursor: null }));
    } else send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } });
  const close = transport.close.bind(transport); transport.close = async () => { closes++; await close(); };
  const runtime = createAppServerWorkbenchRuntime({ hostId: "view-read-lease", transport, autoReconnect: false, maxInactiveThreads, requestTimeoutMs: 60_000, onRecoveryEvent() {} });
  await runtime.connect(); const a = await runtime.acquireThread("a"); a.setRecoveryVisibility(true);
  for (let i = 0; i < 30 && !a.getSnapshot().authoritative; i++) await flush();
  if (!a.getSnapshot().authoritative) {
    const diagnostic = JSON.stringify({ host: runtime.getSnapshot(), view: a.getSnapshot() });
    await runtime.dispose(); assert.fail(`acquired View must remain resident until its baseline: ${diagnostic}`);
  }
  return { runtime, a, replies, methods, closes: () => closes, async close() { for (const reply of replies) reply(); await runtime.dispose(); } };
}
async function waitForReply(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  for (let i = 0; i < 30 && f.replies.length < count; i++) await flush(); assert.equal(f.replies.length, count);
}
for (const maxInactiveThreads of [0, 4]) test(`last View releases optional older read with cache allowance ${maxInactiveThreads}`, { timeout: 5000 }, async () => {
  const f = await fixture(maxInactiveThreads); let settled = false;
  try {
    const pending = f.a.loadOlder().then(() => { settled = true; }, () => { settled = true; }); await waitForReply(f);
    assert.equal(f.runtime.getThreadResidency("a")?.pendingCommandCount, 0, "a presentation read is not an execution command");
    f.a.release(); for (let i = 0; i < 8; i++) await flush();
    assert.equal(settled, true, "last View must settle the local wait before the held reply"); await pending;
    assert.equal(f.closes(), 0); assert.equal(f.runtime.getSnapshot().phase, "ready");
    if (maxInactiveThreads === 0) assert.equal(f.runtime.getThreadResidency("a"), null);
    else { assert.equal(f.a.getSnapshot().authoritative, true); assert.equal(f.a.getSnapshot().history.error, null); assert.equal(f.a.getSnapshot().history.loading, false); }
    const b = await f.runtime.acquireThread("a"); b.setRecoveryVisibility(true);
    for (let i = 0; i < 30 && !b.getSnapshot().authoritative; i++) await flush();
    const fresh = b.loadOlder(); await waitForReply(f, 2); f.replies[1]!(); await fresh;
    f.replies[0]!(); for (let i = 0; i < 5; i++) await flush();
    assert.match(JSON.stringify(b.getSnapshot()), /older-1/); assert.doesNotMatch(JSON.stringify(b.getSnapshot()), /older-0/);
    assert.equal(f.methods.includes("turn/start"), false); assert.equal(f.methods.includes("thread/resume"), false); b.release();
  } finally { await f.close(); }
});
test("another retained View keeps the shared read alive", { timeout: 5000 }, async () => {
  const f = await fixture(); let settled = false;
  try {
    const b = await f.runtime.acquireThread("a"); const pending = f.a.loadOlder().then(() => { settled = true; }, () => { settled = true; }); await waitForReply(f);
    f.a.release(); for (let i = 0; i < 8; i++) await flush(); assert.equal(settled, false); assert.equal(f.closes(), 0);
    f.replies[0]!(); await pending; assert.match(JSON.stringify(b.getSnapshot()), /older-0/); b.release();
  } finally { await f.close(); }
});
test("the final observer release retires its optional read after the View left", { timeout: 5000 }, async () => {
  const f = await fixture(); let settled = false;
  try {
    const unsubscribe = f.a.subscribe(() => undefined); const pending = f.a.loadOlder().then(() => { settled = true; }, () => { settled = true; }); await waitForReply(f);
    f.a.release(); for (let i = 0; i < 6; i++) await flush(); assert.equal(settled, false);
    unsubscribe(); for (let i = 0; i < 8; i++) await flush(); assert.equal(settled, true); await pending;
    assert.equal(f.a.getSnapshot().authoritative, true); assert.equal(f.a.getSnapshot().history.error, null); assert.equal(f.closes(), 0);
  } finally { await f.close(); }
});
test("released View cannot start another optional read", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    f.a.release(); let failure: unknown;
    const pending = f.a.loadOlder().catch(error => { failure = error; });
    for (let i = 0; i < 8; i++) await flush();
    assert.ok(failure instanceof Error && /lease is released/.test(failure.message), "released lease must reject before admitting I/O");
    assert.equal(f.replies.length, 0); await pending;
  }
  finally { await f.close(); }
});

test("an admitted replacement View keeps an older read alive across asynchronous lease handoff", { timeout: 5000 }, async () => {
  const f = await fixture(); let settled = false;
  try {
    const pending = f.a.loadOlder().then(() => { settled = true; }, () => { settled = true; }); await waitForReply(f);
    const acquiring = f.runtime.acquireThread("a"); f.a.release();
    const b = await acquiring; for (let i = 0; i < 6; i++) await flush();
    assert.equal(settled, false); assert.equal(f.replies.length, 1);
    f.replies[0]!(); await pending; assert.match(JSON.stringify(b.getSnapshot()), /older-0/); b.release();
  } finally { await f.close(); }
});
test("concurrent cold View acquisitions reserve residency before observers with zero cache allowance", { timeout: 5000 }, async () => {
  const f = await fixture(0);
  try {
    const [b, c] = await Promise.all([f.runtime.acquireThread("b"), f.runtime.acquireThread("b")]);
    for (let i = 0; i < 30 && !b.getSnapshot().authoritative; i++) await flush();
    assert.equal(b.getSnapshot().authoritative, true); assert.equal(c.getSnapshot().authoritative, true);
    assert.equal(f.runtime.getThreadResidency("b")?.viewLeaseCount, 2);
    b.release(); assert.equal(f.runtime.getThreadResidency("b")?.viewLeaseCount, 1);
    c.release(); assert.equal(f.runtime.getThreadResidency("b"), null);
    assert.equal(f.a.getSnapshot().authoritative, true); f.a.release(); assert.equal(f.closes(), 0);
  } finally { await f.close(); }
});


test("last View can retire an admitted older read before its asynchronous module starts I/O", { timeout: 5000 }, async () => {
  const f = await fixture(); let settled = false;
  try {
    const pending = f.a.loadOlder().then(() => { settled = true; }, () => { settled = true; });
    f.a.release(); for (let i = 0; i < 8; i++) await flush();
    assert.equal(settled, true); assert.equal(f.replies.length, 0); await pending;
    assert.equal(f.a.getSnapshot().authoritative, true); assert.equal(f.a.getSnapshot().history.error, null);
  } finally { await f.close(); }
});
