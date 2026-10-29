import test from "node:test";
test("fork turn boundaries select the generation that actually owns the logical turn", () => {
  const routing = new DshSessionRouting(":memory:");
  routing.publish("parent", { logicalId: "parent", nativeId: "parent.g1", generation: 1, seedThroughSeq: 20, seedThroughTurn: 2, previousLastSeq: 50, previousLastTurn: 5 });
  assert.deepEqual(routing.forkCoordinates("parent", 4), { nativeId: "parent", lastTurn: 4, beforeTurn: undefined });
  assert.deepEqual(routing.forkCoordinates("parent", 7), { nativeId: "parent.g1", lastTurn: 4, beforeTurn: undefined });
  routing.close();
});
import assert from "node:assert/strict";
import { DshSessionRouting } from "../../apps/local-agent-host/src/dsh-session-routing.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native head validates lifecycle and translates empty, seed-only and authored cuts", () => {
  const routing = new DshSessionRouting(":memory:");
  try {
    const original = routing.current("s");
    assert.deepEqual(routing.resolveHistoryHead(original, { sessionId: "s", nextSeq: 0 }), { nextSeq: 0 });
    for (const head of [undefined, null, {}, { sessionId: "other", nextSeq: 10 }, { sessionId: "s", nextSeq: -1 }, { sessionId: "s", nextSeq: "10" }, { sessionId: "s", nextSeq: Number.MAX_SAFE_INTEGER + 1 }])
      assert.equal(routing.resolveHistoryHead(original, head), undefined);
    routing.publish("s", { logicalId: "s", nativeId: "s.g1", generation: 1, seedThroughSeq: 9, seedThroughTurn: 2, previousLastSeq: 99, previousLastTurn: 6 });
    assert.throws(() => routing.resolveHistoryHead(original, { sessionId: "s", nextSeq: 100 }), /generation changed/);
    const current = routing.current("s");
    assert.equal(routing.resolveHistoryHead(current, { sessionId: "s.g1", nextSeq: 9 }), undefined, "native rewind inside seed is not a logical head");
    assert.deepEqual(routing.resolveHistoryHead(current, { sessionId: "s.g1", nextSeq: 10 }), { nextSeq: 100 });
    assert.deepEqual(routing.resolveHistoryHead(current, { sessionId: "s.g1", nextSeq: 15 }), { nextSeq: 105 });
    const raw = { type: "assistant/chunk", seq: 11, time: 1, data: { turn: 3 }, sourceEventSeqs: [10, 11], surfaceOp: { start: 10, end: 12 } };
    assert.deepEqual(routing.eventInGeneration(current, raw), routing.event("s.g1", raw));
    assert.equal(routing.eventInGeneration(current, { ...raw, seq: 9 }), null);
  } finally { routing.close(); }
});

test("generation seed is hidden; fresh events retain monotonic logical coordinates", () => {
  const routing = new DshSessionRouting(":memory:");
  try {
    routing.stage("s", "s.g1");
    assert.equal(routing.frame({ payload: { type: "host/session-added", sessionId: "s.g1" } }), null);
    routing.publish("s", { logicalId: "s", nativeId: "s.g1", generation: 1, seedThroughSeq: 9, seedThroughTurn: 2, previousLastSeq: 99, previousLastTurn: 6 });
    assert.equal(routing.hidden("s.g1"), false);
    assert.equal(routing.event("s.g1", { type: "user/message", seq: 8, time: 1, data: {} }), null);
    const first = routing.event("s.g1", { type: "turn/start", seq: 10, time: 1, data: { turn: 3 } })!;
    assert.equal(first.seq, 100);
    assert.equal((first.data as any).turn, 7);
    assert.equal(routing.frame({ payload: { type: "session/event", sessionId: "s", event: first } }), null);
    assert.equal(routing.frame({ payload: { type: "session/event", sessionId: "s.g1", event: { ...first, seq: 10, data: { turn: 3 } } } })?.payload.sessionId, "s");
    assert.throws(() => routing.publish("s", { ...routing.current("s"), nativeId: "s.g2", generation: 2 }), /authority/);
  } finally { routing.close(); }
});
test("logical/native routes and original history lineage survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-route-"));
  try {
    const path = join(root, "routes.sqlite");
    const a = new DshSessionRouting(path);
    a.publish("s", { logicalId: "s", nativeId: "s.g1", generation: 1, seedThroughSeq: 4, seedThroughTurn: 1, previousLastSeq: 8, previousLastTurn: 2 });
    a.close();
    const b = new DshSessionRouting(path);
    try {
      assert.equal(b.native("s"), "s.g1");
      assert.equal(b.logical("s.g1"), "s");
      assert.deepEqual(b.generations("s").map(value => value.nativeId), ["s", "s.g1"]);
    } finally { b.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart reconciles a committed checkpoint with a durable unpublished routing intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-commit-gap-"));
  try {
    const path = join(root, "routing.sqlite");
    const beforeCrash = new DshSessionRouting(path);
    beforeCrash.stage("s", "s.g1", { expectedNativeId: "s", generation: 1, previousLastSeq: 90, previousLastTurn: 4 });
    beforeCrash.close();
    const restored = new DshSessionRouting(path);
    try {
      assert.equal(restored.hidden("s.g1"), true);
      assert.equal(restored.reconcile("s", { sessionId: "s", generation: 0 }), false, "uncommitted checkpoint cannot publish a pending generation");
      assert.throws(() => restored.reconcile("s", { sessionId: "s.g1", generation: 1 }), /evidence/);
      assert.equal(restored.reconcile("s", { sessionId: "s.g1", generation: 1, seedThroughSeq: 8, seedThroughTurn: 2 }), true);
      assert.equal(restored.native("s"), "s.g1");
      assert.equal(restored.hidden("s.g1"), false);
      assert.deepEqual(restored.pending(), []);
      assert.equal(restored.reconcile("s", { sessionId: "s.g1", generation: 1, seedThroughSeq: 8, seedThroughTurn: 2 }), false, "reconciliation is idempotent");
      const event = restored.event("s.g1", { type: "turn/start", seq: 9, time: 1, data: { turn: 3 } })!;
      assert.equal(event.seq, 91);
      assert.equal((event.data as any).turn, 5);
    } finally { restored.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
for (const schema of ["current", "without-intent", "missing-pending", "missing-generations", "unknown"] as const) {
  test(`previous routing schema ${schema}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencraft-routing-legacy-"));
    const path = join(root, "routing.sqlite");
    const hasGeneration = schema !== "unknown" && schema !== "missing-generations";
    const pending = schema === "unknown" || schema === "missing-pending" ? [] : [{ logicalId: "s", nativeId: "pending", intent: null }];
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE IF NOT EXISTS dsh_session_generations (
        logical_id TEXT NOT NULL, native_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
        seed_seq INTEGER NOT NULL, seed_turn INTEGER NOT NULL, prior_seq INTEGER NOT NULL, prior_turn INTEGER NOT NULL,
        PRIMARY KEY(logical_id,generation)
      ); CREATE TABLE IF NOT EXISTS dsh_pending_generations (native_id TEXT PRIMARY KEY, logical_id TEXT NOT NULL)`);
      if (schema === "current") legacy.exec("ALTER TABLE dsh_pending_generations ADD COLUMN intent TEXT");
      if (schema === "unknown") legacy.exec("CREATE TABLE unknown_owner_data(id TEXT PRIMARY KEY)");
      legacy.exec("INSERT INTO dsh_session_generations VALUES('s','s.g1',1,4,1,8,2); INSERT INTO dsh_pending_generations(native_id,logical_id) VALUES('pending','s')");
      if (schema === "missing-pending") legacy.exec("DROP TABLE dsh_pending_generations");
      if (schema === "missing-generations") legacy.exec("DROP TABLE dsh_session_generations");
      legacy.close();
      if (schema === "unknown") {
        assert.throws(() => new DshSessionRouting(path), (error: unknown) => (error as { kind?: string }).kind === "unsupported-legacy");
        const retained = new DatabaseSync(path, { readOnly: true });
        assert.equal(retained.prepare("SELECT native_id FROM dsh_session_generations").get()?.native_id, "s.g1"); retained.close(); return;
      }
      const routing = new DshSessionRouting(path);
      try {
        assert.equal(routing.outcome.status, schema === "current" ? "adopted" : "migrated");
        assert.ok(routing.outcome.backupPath);
        assert.equal(routing.native("s"), hasGeneration ? "s.g1" : "s");
        assert.deepEqual(routing.pending(), pending);
        if (hasGeneration) {
          assert.deepEqual(routing.current("s"), {
            logicalId: "s", nativeId: "s.g1", generation: 1, seedThroughSeq: 4,
            seedThroughTurn: 1, previousLastSeq: 8, previousLastTurn: 2,
          });
        }
        if (pending.length > 0) {
          assert.deepEqual(routing.pending(), [{ logicalId: "s", nativeId: "pending", intent: null }]);
          assert.throws(() => routing.reconcile("s", { sessionId: "pending", generation: 2, seedThroughSeq: 4, seedThroughTurn: 1 }), /Incomplete generation publication evidence/);
          assert.equal(routing.native("s"), hasGeneration ? "s.g1" : "s");
          assert.equal(routing.pending().length, 1);
        }
        const files = await readdir(root);
        assert.ok(files.some(name => name.includes(".pre-v1-")));
        assert.equal(files.some(name => name.includes(".legacy-")), schema === "unknown");
        if (schema === "unknown") {
          for (const retained of [routing.outcome.backupPath!, routing.outcome.movedAsidePaths[0]!]) {
            const check = new DatabaseSync(retained);
            assert.equal(check.prepare("SELECT native_id FROM dsh_session_generations").get()?.native_id, "s.g1");
            check.close();
          }
        }
      } finally { routing.close(); }
      const again = new DshSessionRouting(path);
      try {
        assert.equal(again.outcome.status, "up-to-date");
        assert.equal(again.outcome.backupPath, undefined);
        assert.equal(again.native("s"), hasGeneration ? "s.g1" : "s");
        assert.deepEqual(again.pending(), pending);
      } finally { again.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
