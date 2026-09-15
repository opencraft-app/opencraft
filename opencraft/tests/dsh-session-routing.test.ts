import test from "node:test";
import assert from "node:assert/strict";
import { DshSessionRouting } from "../apps/local-agent-host/src/dsh-session-routing.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
