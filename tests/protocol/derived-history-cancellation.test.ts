import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime, type HydratedThreadHistory } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(kind: "older" | "refresh" | "background") {
  let reads = 0, entered = false, finish!: () => void, fail!: (error: Error) => void;
  const held = new Promise<void>((done, reject) => { finish = done; fail = reject; });
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "derived-history" }); return; }
    if (request.method === "thread/read") reads++;
    const threadId = (request.params as { threadId?: string }).threadId ?? "a";
    send({ thread: { id: threadId, sessionId: threadId, path: "/fixture/history", cwd: "/workspace", updatedAt: reads, historyMode: "message-window", turns: [] },
      model: "fixture", modelProvider: "fixture", cwd: "/workspace", runtimeWorkspaceRoots: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {},
      initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
  } });
  const client = new JsonRpcAppServerClient({ hostId: "derived-history", transport });
  await client.connect({ clientInfo: { name: "derived-history", version: "1" }, capabilities: {} });
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window", drainTailHistory: kind === "background" });
  const loads = new Map<string, number>(), olderLoads = new Map<string, number>();
  const history: HydratedThreadHistory = { source: "message-window", turns: [], complete: false, olderCursor: "older", itemsPaginationByTurnId: {} };
  session.historyStrategies.register({ name: "fork", priority: 1000, matches: () => true,
    async load(context) {
      const count = (loads.get(context.threadId) ?? 0) + 1; loads.set(context.threadId, count);
      if (context.threadId === "a" && count === 2 && kind === "refresh") { entered = true; await held; }
      return { ...history, ...(kind === "background" ? { drainRemaining: async () => { entered = true; await held; return []; } } : {}) };
    },
    async loadOlder(context) {
      const count = (olderLoads.get(context.threadId) ?? 0) + 1; olderLoads.set(context.threadId, count);
      if (context.threadId === "a" && count === 1) { entered = true; await held; }
      return { ...history, complete: true, olderCursor: null };
    },
  });
  await session.resume.resume({ threadId: "a" });
  return { session, client, finish, fail, entered: () => entered, async close() { finish(); await session.dispose(); await client.close(); } };
}

for (const kind of ["older", "refresh", "background"] as const) for (const revoke of ["baseline", "release", "dispose", "needs-resume", "presentation"] as const) {
  test(`${kind} local wait settles on ${revoke} while its old strategy remains held`, { timeout: 3000 }, async () => {
    const f = await fixture(kind); let settled = false;
    try {
      const pending = kind === "older" ? f.session.resume.loadOlder("a") : kind === "refresh" ? f.session.resume.refreshHistory("a") : f.session.resume.waitForBackgroundHistory("a");
      const observed = pending.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
      if (revoke === "baseline") await f.session.resume.read("a");
      else if (revoke === "release") f.session.resume.release("a");
      else if (revoke === "needs-resume") f.session.resume.markNeedsResume("a");
      else if (revoke === "presentation") f.session.resume.cancelDerivedHistory("a");
      else await f.session.dispose();
      for (let i = 0; i < 5; i++) await flush();
      assert.equal(settled, true, "revocation must settle the local caller before the retired strategy completes");
      await observed;
      if (revoke === "presentation") {
        assert.equal(f.session.views.get("a")?.resumeState, "resumed", "optional cancellation retains baseline authority");
        assert.equal(f.session.views.get("a")?.historyError, null);
      }
    } finally { await f.close(); }
  });
}

test("refresh signal settles locally while a strategy ignores cancellation", { timeout: 3000 }, async () => {
  const f = await fixture("refresh"), controller = new AbortController(); let settled = false;
  try {
    const pending = f.session.resume.refreshHistory("a", controller.signal).then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    controller.abort(); for (let i = 0; i < 5; i++) await flush();
    assert.equal(settled, true, "AbortSignal must settle the local refresh waiter without a strategy reply"); await pending;
  } finally { await f.close(); }
});

for (const kind of ["older", "refresh"] as const) test(`${kind} joining cancellation preserves its initiating owner`, async () => {
  const f = await fixture(kind), controller = new AbortController(); let firstSettled = false, joinedSettled = false;
  try {
    const first = kind === "older" ? f.session.resume.loadOlder("a") : f.session.resume.refreshHistory("a");
    const firstResult = first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    const same = kind === "older" ? f.session.resume.loadOlder("a") : f.session.resume.refreshHistory("a");
    assert.equal(same, first, "unsignalled callers must share the admitted operation");
    const joined = kind === "older" ? f.session.resume.loadOlder("a", controller.signal) : f.session.resume.refreshHistory("a", controller.signal);
    const joinedResult = joined.then(() => { joinedSettled = true; }, () => { joinedSettled = true; });
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    controller.abort(); for (let i = 0; i < 5; i++) await flush();
    assert.equal(joinedSettled, true); assert.equal(firstSettled, false);
    assert.equal(f.session.views.get("a")?.resumeState, "resumed");
    f.finish(); await firstResult; await joinedResult;
  } finally { await f.close(); }
});

for (const kind of ["older", "refresh"] as const) test(`${kind} preaborted caller cannot join a held owner`, async () => {
  const f = await fixture(kind), controller = new AbortController(); controller.abort();
  try {
    const first = kind === "older" ? f.session.resume.loadOlder("a") : f.session.resume.refreshHistory("a");
    let settled = false;
    const cancelled = (kind === "older" ? f.session.resume.loadOlder("a", controller.signal) : f.session.resume.refreshHistory("a", controller.signal))
      .then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 5; i++) await flush(); assert.equal(settled, true); await cancelled;
    f.finish(); await first;
  } finally { await f.close(); }
});

test("queued refresh cancellation settles without cancelling its older-page predecessor", async () => {
  const f = await fixture("older"), controller = new AbortController(); let olderSettled = false;
  try {
    const older = f.session.resume.loadOlder("a").finally(() => { olderSettled = true; });
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    const refresh = f.session.resume.refreshHistory("a", controller.signal);
    controller.abort(); assert.equal(await refresh, false); assert.equal(olderSettled, false);
    f.finish(); await older;
    assert.equal(f.session.views.get("a")?.resumeState, "resumed");
  } finally { await f.close(); }
});

test("older signal cancellation clears loading paint while retaining the current baseline", async () => {
  const f = await fixture("older"), controller = new AbortController();
  try {
    const older = f.session.resume.loadOlder("a", controller.signal);
    const cancelled = assert.rejects(older, error => (error as { code?: string }).code === "ABORTED");
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    assert.equal(f.session.views.get("a")?.turnsPagination.isLoadingOlder, true);
    controller.abort(); await cancelled;
    assert.equal(f.session.views.get("a")?.turnsPagination.isLoadingOlder, false);
    assert.equal(f.session.views.get("a")?.resumeState, "resumed"); assert.equal(f.session.views.get("a")?.historyError, null);
  } finally { await f.close(); }
});

test("cancelling an older-page predecessor lets an independently requested refresh proceed", async () => {
  const f = await fixture("older"), controller = new AbortController();
  try {
    const older = f.session.resume.loadOlder("a", controller.signal);
    const cancelled = assert.rejects(older, error => (error as { code?: string }).code === "ABORTED");
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    const refresh = f.session.resume.refreshHistory("a");
    controller.abort(); await cancelled;
    assert.equal(await refresh, true, "serialization requires predecessor settlement, not its success");
    assert.equal(f.session.views.get("a")?.resumeState, "resumed");
  } finally { await f.close(); }
});

for (const kind of ["older", "refresh"] as const) test(`${kind} retired failure cannot change a successful same-source successor`, async () => {
  const f = await fixture(kind), controller = new AbortController();
  try {
    const old = kind === "older" ? f.session.resume.loadOlder("a", controller.signal) : f.session.resume.refreshHistory("a", controller.signal);
    const settled = old.catch(() => undefined);
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    controller.abort(); await settled;
    if (kind === "older") await f.session.resume.loadOlder("a"); else assert.equal(await f.session.resume.refreshHistory("a"), true);
    f.fail(new Error("retired strategy failed")); for (let i = 0; i < 5; i++) await flush();
    assert.equal(f.session.views.get("a")?.resumeState, "resumed"); assert.equal(f.session.views.get("a")?.historyError, null);
    assert.equal(f.session.views.get("a")?.turnsPagination.isLoadingOlder, false);
  } finally { await f.close(); }
});

for (const kind of ["older", "refresh"] as const) test(`${kind} revocation preserves another Thread's independent source`, async () => {
  const f = await fixture(kind), controller = new AbortController();
  try {
    const pending = (kind === "older" ? f.session.resume.loadOlder("a", controller.signal) : f.session.resume.refreshHistory("a", controller.signal)).catch(() => undefined);
    for (let i = 0; i < 12 && !f.entered(); i++) await flush(); assert.equal(f.entered(), true);
    await f.session.resume.resume({ threadId: "b" });
    await f.session.resume.loadOlder("b"); controller.abort(); await pending;
    assert.equal(f.session.views.get("b")?.resumeState, "resumed"); assert.equal(f.session.views.get("b")?.historyError, null);
    assert.equal(f.client.status.state, "open");
  } finally { await f.close(); }
});
