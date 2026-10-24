import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError, AppServerClientError, threadUnavailableReason, isRetryableAppServerRpcError } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const thread = (id: string) => ({ id, sessionId: id, name: id, cwd: "/workspace", path: `/rollouts/${id}`, historyMode: "paginated", status: { type: "idle" }, turns: [] });

for (const [message, code, reason] of [
  ["workspace view has been destroyed", -32071, "archived"],
  ["Thread old is archived", -32600, "archived"],
  ["cannot resume archived thread", -32602, "archived"],
  ["no rollout found for thread id old", -32600, "not-found"],
  ["thread not found: old", -32000, "not-found"],
  ["Thread no longer exists", -32000, "not-found"],
  ["thread old not found", -32000, "not-found"],
  ["thread foo bar not found", -32000, "not-found"],
  ["thread  not found", -32000, "not-found"],
  ["thread: not found", -32000, "not-found"],
  ["thread old: not found", -32000, "not-found"],
  ["a-thread not found", -32000, "not-found"],
  ["thread\nnot found", -32000, "not-found"],
  ["THREAD NOT FOUND", -32000, "not-found"],
  [`thread${" ".repeat(64)}not found`, -32000, "not-found"],
  [`thread${" ".repeat(64)}no longer exists`, -32000, "not-found"],
  [`thread${" ".repeat(64)}x not found`, -32000, "not-found"],
] as const) test(`terminal Thread rejection: ${message}`, () => {
  const error = new AppServerRpcError({ code, message, data: { retryable: true } });
  assert.equal(threadUnavailableReason(error), reason);
  assert.equal(isRetryableAppServerRpcError(error), false);
  assert.equal(threadUnavailableReason(new AppServerClientError("TRANSPORT_ERROR", message)), null);
});
test("unrelated missing resources and transient failures cannot retire a Thread", () => {
  for (const message of [
    "model not found",
    "history service unavailable",
    "archived messages unavailable",
    "threads not found",
    "thread2 not found",
    "thread not founded",
    "thread : not found",
    "thread:not found",
    "thread not  found",
    "thread-id not found",
    "thread old\nbar not found",
    "thread foo: bar not found",
    "thread:  not found",
    `thread${" ".repeat(64)}x`,
  ]) {
    const error = new AppServerRpcError({ code: -32000, message, data: { retryable: true } });
    assert.equal(threadUnavailableReason(error), null);
    assert.equal(isRetryableAppServerRpcError(error), true);
  }
  assert.equal(isRetryableAppServerRpcError(new AppServerRpcError({ code: -32602, message: "bad params", data: { retryable: true } })), false);
});

function fixture(failure?: { code: number; message: string }) {
  let peer!: InMemoryAppServerPeer;
  let hold = false, release: (() => void) | undefined;
  let rejected = failure;
  const requests: Array<{ method: string; id?: string }> = [];
  const transport = new MemoryTransport({ connected(value) { peer = value; }, receive(frame, reply) {
    const request = JSON.parse(frame); if (request.id === undefined) return;
    const id = request.params?.threadId; requests.push({ method: request.method, id });
    const send = (result: unknown) => reply.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "unavailable-test" });
    else if (request.method === "thread/unarchive") { rejected = undefined; send({ thread: thread(id) }); }
    else if (request.method === "thread/read") send({ thread: thread(id) });
    else if (request.method === "thread/resume") {
      if (rejected && id === "old") { reply.send(JSON.stringify({ id: request.id, error: { ...rejected, data: { retryable: true } } })); return; }
      const complete = () => send({ thread: thread(id), model: "test", modelProvider: "test", cwd: "/workspace",
        approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: ["/workspace"],
        sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] }, initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      if (hold && id === "old") release = complete; else complete();
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "unavailable", transport, autoReconnect: false, reconnectDelaysMs: [1], requestTimeoutMs: 1000 });
  return { runtime, requests, hold() { hold = true; }, release() { assert.ok(release); release(); },
    notify(method: string, threadId = "old") { peer.send(JSON.stringify({ method, params: { threadId } })); },
    disconnect() { peer.close("synthetic network loss"); } };
}

for (const failure of [{ code: -32071, message: "Thread is archived" }, { code: -32600, message: "no rollout found for thread id old" }]) {
  test(`${failure.message}: no automatic, manual or reconnect replay until unarchive`, async () => {
    const f = fixture(failure), events: string[] = [];
    const stop = f.runtime.resources.threads.subscribeUnavailable!((id, reason) => events.push(`${id}:${reason}`));
    try {
      await f.runtime.connect(); const lease = await f.runtime.acquireThread("old"); lease.setRecoveryVisibility(true);
      await settle();
      assert.equal(f.requests.filter(r => r.method === "thread/resume").length, 1);
      assert.equal(events.length, 1);
      assert.equal(lease.getSnapshot().authoritative, false);
      await lease.retryRestore(); await settle();
      f.disconnect(); await f.runtime.reconnect(); await settle();
      assert.equal(f.requests.filter(r => r.method === "thread/resume").length, 1);
      const healthy = await f.runtime.acquireThread("healthy"); await settle();
      assert.equal(healthy.getSnapshot().authoritative, true);
      assert.equal(f.runtime.getSnapshot().phase, "ready");
      assert.equal(f.requests.some(r => ["thread/start", "turn/start", "turn/steer"].includes(r.method)), false);
      lease.release(); healthy.release();
    } finally { stop(); await f.runtime.dispose(); }
  });
}
test("archive acknowledgement stops restoration without notification; unarchive allows explicit reopening", async () => {
  const f = fixture();
  try {
    await f.runtime.connect(); const lease = await f.runtime.acquireThread("old"); await settle();
    assert.equal(lease.getSnapshot().authoritative, true);
    await f.runtime.resources.threads.archive!("old");
    assert.equal(f.runtime.resources.threads.getUnavailableReason!("old"), "archived");
    assert.equal(lease.getSnapshot().authoritative, false);
    f.disconnect(); await f.runtime.reconnect(); await settle();
    assert.equal(f.requests.filter(r => r.method === "thread/resume").length, 1);
    await f.runtime.resources.threads.unarchive!("old"); await lease.retryRestore(); await settle();
    assert.equal(lease.getSnapshot().authoritative, true);
    assert.equal(f.requests.filter(r => r.method === "thread/resume").length, 2);
    lease.release();
  } finally { await f.runtime.dispose(); }
});
test("archive notification fences a late successful resume", async () => {
  const f = fixture(); f.hold();
  try {
    await f.runtime.connect(); const lease = await f.runtime.acquireThread("old"); await settle();
    f.notify("thread/archived"); await settle(); f.release(); await settle();
    assert.equal(lease.getSnapshot().authoritative, false);
    assert.equal(f.runtime.resources.threads.getUnavailableReason!("old"), "archived");
    assert.equal(f.runtime.getSnapshot().phase, "ready");
    lease.release();
  } finally { await f.runtime.dispose(); }
});

test("confirmed unarchive clears a cached rejection before ordinary acquire in the same connection", async () => {
  const f = fixture({ code: -32071, message: "Thread is archived" });
  try {
    await f.runtime.connect(); const lease = await f.runtime.acquireThread("old"); await settle();
    assert.equal(lease.getSnapshot().authoritative, false);
    await f.runtime.resources.threads.unarchive!("old");
    const reopened = await f.runtime.acquireThread("old"); await settle();
    assert.equal(reopened.getSnapshot().authoritative, true);
    assert.equal(f.requests.filter(r => r.method === "initialize").length, 1);
    assert.equal(f.requests.filter(r => r.method === "thread/resume").length, 2);
    reopened.release(); lease.release();
  } finally { await f.runtime.dispose(); }
});
