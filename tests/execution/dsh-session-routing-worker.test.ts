import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { DshSessionRoutingWorker } from "../../apps/local-agent-host/src/dsh-session-routing-worker.js";

const intent = { expectedNativeId: "s", generation: 1, previousLastSeq: 90, previousLastTurn: 4 };
const checkpoint = { sessionId: "s.g1", generation: 1, seedThroughSeq: 8, seedThroughTurn: 2 };
const frame = (id: string, seq: number) => ({ payload: { type: "session/event", sessionId: id,
  event: { type: "turn/start", seq, time: 1, data: { turn: 3 } } } });

test("a real routing write lock leaves HTTP and committed stream projection live until publication commits", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-routing-worker-lock-"));
  const path = join(root, "routing.sqlite");
  const routing = await DshSessionRoutingWorker.open(path);
  const lock = new DatabaseSync(path);
  const server = createServer((_request, response) => response.end("network alive"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  let locked = false;
  try {
    await routing.stage("s", "s.g1", intent);
    lock.exec("BEGIN IMMEDIATE"); locked = true;
    t.mock.method(DatabaseSync.prototype, "prepare", () => { throw new Error("SQL executed on the network thread"); });
    let committed = false;
    const publish = routing.publish("s", { logicalId: "s", nativeId: "s.g1", generation: 1,
      seedThroughSeq: 8, seedThroughTurn: 2, previousLastSeq: 90, previousLastTurn: 4 }).then(() => { committed = true; });
    // Observe the promise immediately so cleanup can release the real lock even
    // if a regressed synchronous implementation hits its five-second busy limit.
    const completion = publish.then(() => ({ error: null }), error => ({ error }));
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(await response.text(), "network alive");
    assert.equal(committed, false);
    assert.equal(routing.native("s"), "s", "uncommitted native generation must not become authority");
    assert.equal(routing.frame(frame("s.g1", 9)), null, "staged producer remains hidden while commit waits");
    assert.equal(routing.frame(frame("s", 9))?.payload.sessionId, "s", "current producer needs no locked SQL reads");
    lock.exec("ROLLBACK"); locked = false;
    const completed = await completion; if (completed.error) throw completed.error;
    assert.equal(routing.native("s"), "s.g1");
    assert.equal(routing.hidden("s.g1"), false);
    assert.equal((routing.frame(frame("s.g1", 9))?.payload.event as { seq: number }).seq, 91);
    assert.equal(routing.frame(frame("s", 9)), null);
  } finally {
    if (locked) lock.exec("ROLLBACK"); lock.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await routing.close(); await rm(root, { recursive: true, force: true });
  }
});

test("unpublished intent rebuilds after Worker close; committed generation preserves hidden/seq/turn coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-routing-worker-reopen-"));
  const path = join(root, "routing.sqlite");
  let routing = await DshSessionRoutingWorker.open(path);
  try {
    await routing.stage("s", "s.g1", intent);
    await routing.close();
    assert.throws(() => routing.native("s"), /unavailable/);
    routing = await DshSessionRoutingWorker.open(path);
    assert.equal(routing.hidden("s.g1"), true);
    assert.equal(await routing.reconcile("s", { sessionId: "s", generation: 0 }), false);
    assert.equal(await routing.reconcile("s", checkpoint), true);
    const mapped = routing.frame(frame("s.g1", 9))!;
    assert.equal(mapped.payload.sessionId, "s");
    assert.deepEqual(mapped.payload.event, { type: "turn/start", seq: 91, time: 1, data: { turn: 5 } });
    assert.equal(routing.frame(frame("s.g1", 8)), null);
    await routing.close(); routing = await DshSessionRoutingWorker.open(path);
    assert.equal(routing.native("s"), "s.g1");
    assert.deepEqual(routing.pending(), []);
    assert.deepEqual(routing.forkCoordinates("s", 5), { nativeId: "s.g1", lastTurn: 3, beforeTurn: undefined });
  } finally { await routing.close(); await rm(root, { recursive: true, force: true }); }
});

test("a SQLite publication failure fences reads and later mutations; reopen recovers only committed facts", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-routing-worker-failure-"));
  const path = join(root, "routing.sqlite");
  let routing = await DshSessionRoutingWorker.open(path);
  const nextIntent = { expectedNativeId: "s.g1", generation: 2, previousLastSeq: 100, previousLastTurn: 6 };
  try {
    await routing.stage("s", "s.g1", intent);
    await routing.reconcile("s", checkpoint);
    await routing.stage("s", "s.g2", nextIntent);
    // The original native ID is still a durable UNIQUE lineage member. This
    // passes the generation/CAS guard and reaches SQLite's real constraint.
    await assert.rejects(routing.publish("s.g1", { logicalId: "s", nativeId: "s", generation: 2,
      seedThroughSeq: 8, seedThroughTurn: 2, previousLastSeq: 100, previousLastTurn: 6 }), /UNIQUE|constraint/i);
    assert.throws(() => routing.frame(frame("s.g1", 9)), /UNIQUE|constraint/i);
    await assert.rejects(routing.stage("s", "other"), /UNIQUE|constraint/i);
    await assert.rejects(routing.close(), /UNIQUE|constraint/i);
    routing = await DshSessionRoutingWorker.open(path);
    assert.equal(routing.native("s"), "s.g1");
    assert.deepEqual(routing.pending(), [{ logicalId: "s", nativeId: "s.g2", intent: nextIntent }]);
    assert.equal(await routing.reconcile("s", { ...checkpoint, sessionId: "s.g2", generation: 2 }), true);
    assert.equal(routing.native("s"), "s.g2");
  } finally { await routing.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("deterministic publication guards keep committed authority and allow the next valid operation", async () => {
  const routing = await DshSessionRoutingWorker.open(":memory:");
  try {
    await routing.stage("s", "s.g1", intent);
    await assert.rejects(routing.reconcile("s", { sessionId: "s.g1", generation: 1 }), { code: "INCOMPLETE_EVIDENCE" });
    assert.equal(routing.hidden("s.g1"), true);
    await assert.rejects(routing.publish("stale", { logicalId: "s", nativeId: "s.g1", generation: 1,
      seedThroughSeq: 8, seedThroughTurn: 2, previousLastSeq: 90, previousLastTurn: 4 }), { code: "AUTHORITY_CHANGED" });
    assert.equal(routing.native("s"), "s");
    assert.equal(await routing.reconcile("s", checkpoint), true);
    await assert.rejects(routing.publish("s.g1", { logicalId: "s", nativeId: "s.g2", generation: 2,
      seedThroughSeq: -2, seedThroughTurn: 2, previousLastSeq: 100, previousLastTurn: 6 }), { code: "INVALID_ROUTE" });
    await routing.publish("s.g1", { logicalId: "s", nativeId: "s.g2", generation: 2,
      seedThroughSeq: 8, seedThroughTurn: 2, previousLastSeq: 100, previousLastTurn: 6 });
    assert.equal(routing.native("s"), "s.g2");
  } finally { await routing.close(); }
});
