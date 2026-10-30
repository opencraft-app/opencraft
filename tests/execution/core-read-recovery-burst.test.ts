import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { CodexCoreReadIsolation } from "../../apps/opencraft-daemon/src/codex-core-read-isolation";

test("simultaneous history recovery survives one slow native-health probe without losing read RPCs", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-history-recovery-burst-"));
  const nativePath = join(root, "native.sock"), controlPath = join(root, "control.sock");
  const native = createServer(), sockets = new WebSocketServer({ server: native });
  sockets.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id === undefined) return;
    assert.ok(["initialize", "thread/read"].includes(frame.method));
    socket.send(JSON.stringify({ id: frame.id, result: frame.method === "initialize" ? {}
      : { thread: { id: frame.params.threadId, turns: [], status: "idle" } } }));
  }));
  await new Promise<void>(resolve => native.listen(nativePath, resolve));
  let queue = Promise.resolve(), closing = false;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const control = createServer((request, response) => {
    assert.equal(request.url, "/health");
    queue = queue.then(async () => {
      if (closing) return;
      // A cold routing owner has one native-health operation in progress.
      // Duplicating it must not consume every history reader's deadline.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 500);
        timers.set(timer, resolve);
      });
      if (!closing && !response.destroyed) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ protocolVersion: 1, pid: process.ppid,
          codexPid: process.pid, nativeSocket: nativePath }));
      }
    });
  });
  await new Promise<void>(resolve => control.listen(controlPath, resolve));
  const client = new CodexCoreControlClient(controlPath, "synthetic-service-token");
  const reader = new CodexCoreReadIsolation(signal => client.health(signal), {
    maxPayload: 4096, concurrency: 4, queue: 16, timeoutMs: 1_200,
  });
  try {
    const replies = await Promise.all(Array.from({ length: 4 }, (_, id) => reader.read({
      id, method: "thread/read", params: { threadId: `retained-${id}`, includeTurns: false },
    }).then(raw => JSON.parse(raw))));
    assert.deepEqual(replies.map(reply => reply.error?.data?.code ?? reply.result.thread.id),
      ["retained-0", "retained-1", "retained-2", "retained-3"],
      "all current history readers settle before their own deadline, without replay or a subscription reset");
  } finally {
    closing = true;
    reader.close();
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    timers.clear();
    control.closeAllConnections();
    await new Promise<void>(resolve => control.close(() => resolve()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => native.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("one cancelled health consumer cannot cancel a peer, and the next directory read observes a new owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-history-health-cancel-"));
  const path = join(root, "control.sock");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { arrived = resolve; });
  let epoch = "before", holding = true, mismatch = false;
  const server = createServer((request, response) => { void (async () => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      arrived();
      if (holding) await gate;
      response.end(JSON.stringify({ protocolVersion: 1, pid: process.ppid, codexPid: process.pid,
        nativeSocket: join(root, "native.sock"), routingEpoch: epoch }));
    } else {
      assert.equal(request.url, "/generation-directory?threadId=thread");
      response.end(JSON.stringify({ protocolVersion: 1, routingEpoch: mismatch ? "replacement" : epoch,
        admissionEpoch: 1, homes: [{ generationId: "retained", codexHome: root, incarnation: 1 }],
        route: { threadId: "thread", generationId: "retained" } }));
    }
  })(); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = new CodexCoreControlClient(path, "synthetic-service-token");
  const cancelled = new AbortController();
  const first = client.health(cancelled.signal);
  const firstRejected = assert.rejects(first, /cancelled consumer/);
  const peer = client.health();
  const observer = client.health();
  try {
    await accepted;
    cancelled.abort(new Error("cancelled consumer"));
    release();
    await firstRejected;
    const own = await peer;
    assert.equal(own.routingEpoch, "before");
    (own as { routingEpoch: string }).routingEpoch = "consumer-local-change";
    assert.equal((await observer).routingEpoch, "before", "consumers retain independently mutable response objects");
    holding = false;
    epoch = "after";
    assert.equal((await client.generationDirectory("thread"))?.routingEpoch, "after",
      "a completed observation is not a health cache or authority for a later read");
    mismatch = true;
    await assert.rejects(client.generationDirectory("thread"), /owner changed/,
      "sharing an in-flight health probe does not bypass the fresh directory epoch check");
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("retiring the last history slot cancels its shared probe so a successor can recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-history-health-reset-"));
  const path = join(root, "control.sock"), nativePath = join(root, "native.sock");
  let accepted!: () => void, calls = 0;
  const firstAccepted = new Promise<void>(resolve => { accepted = resolve; });
  const control = createServer((_request, response) => {
    if (++calls === 1) { accepted(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ protocolVersion: 1, pid: process.ppid, codexPid: process.pid, nativeSocket: nativePath }));
  });
  const native = createServer(), sockets = new WebSocketServer({ server: native });
  sockets.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id !== undefined) socket.send(JSON.stringify({ id: frame.id, result: frame.method === "initialize" ? {}
      : { thread: { id: frame.params.threadId, turns: [] } } }));
  }));
  await new Promise<void>(resolve => control.listen(path, resolve));
  await new Promise<void>(resolve => native.listen(nativePath, resolve));
  const client = new CodexCoreControlClient(path, "synthetic-service-token");
  const reader = new CodexCoreReadIsolation(signal => client.health(signal), {
    maxPayload: 4096, concurrency: 1, queue: 4, timeoutMs: 1_000,
  });
  try {
    const old = reader.read({ id: "old", method: "thread/read", params: { threadId: "retained" } });
    await firstAccepted;
    reader.reset();
    assert.equal(JSON.parse(await old).error.data.code, "HISTORY_READ_UNAVAILABLE");
    const current = JSON.parse(await reader.read({ id: "current", method: "thread/read", params: { threadId: "retained" } }));
    assert.equal(current.result?.thread.id, "retained", "a new slot cannot join a retired health request");
  } finally {
    reader.close();
    control.closeAllConnections();
    await new Promise<void>(resolve => control.close(() => resolve()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => native.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
