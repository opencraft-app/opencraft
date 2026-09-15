import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshCheckpointStore } from "../apps/local-agent-host/src/dsh-checkpoint-store.mjs";
import { createSurfaceCheckpoint } from "../apps/local-agent-host/src/hypernode/surface-checkpoint.mjs";
import { isSurfaceEvent } from "../runtime/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
const projection = createSurfaceCheckpoint(isSurfaceEvent);
const session = id => ({ id, header: { id }, events: [{ type: "user/message", seq: 0, time: 1, surfaceOp: "append",
  data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "fixture" }] } }], surface: { nodes: [0] } });
test("checkpoint commit follows flush, survives failed flush and rejects stale generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-checkpoint-"));
  try {
    const store = new DshCheckpointStore(root, projection);
    let flushed = false;
    await store.capture("logical", session("native"), 0, async () => { flushed = true; });
    assert.ok(flushed);
    assert.equal((await stat(store.path("logical"))).mode & 0o777, 0o600);
    await assert.rejects(store.capture("logical", session("native.g1"), 1, async () => { throw new Error("flush failed"); }), /flush/);
    assert.equal((await store.read("logical")).sourceSessionId, "native");
    await store.capture("logical", session("native.g1"), 1, async () => {}, { seedThroughSeq: 0, seedThroughTurn: 1 });
    await store.capture("logical", session("native.g1"), 1, async () => {});
    assert.deepEqual((await store.read("logical")).seedCoordinates, { seedThroughSeq: 0, seedThroughTurn: 1 }, "later captures retain the original seed boundary");
    await assert.rejects(store.capture("logical", session("native"), 0, async () => {}), /Stale/);
    assert.equal((await store.read("logical")).generation, 1);
    await assert.rejects(store.capture("logical", session("wrong.g1"), 1, async () => {}), /source/);
    await assert.rejects(store.prepare("logical", "wrong", async () => []), /generation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("generation uses watermark tail and closes crashed work without rewriting original log", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-generation-"));
  try {
    const store = new DshCheckpointStore(root, projection);
    const original = session("native");
    await store.capture("logical", original, 0, async () => {});
    const generation = await store.prepare("logical", "native", async (id, fromSeq) => {
      assert.equal(id, "native"); assert.equal(fromSeq, 1);
      return [{ type: "turn/start", seq: 1, time: 2, data: { turn: 2 } }];
    });
    assert.equal(generation.sessionId, "logical.g1");
    assert.equal(generation.interruptedTurns, 1);
    assert.equal(generation.seed.at(-1).data.reason.kind, "interrupted");
    assert.equal(original.events.length, 1);
    await writeFile(store.path("logical"), "{}");
    await assert.rejects(store.read("logical"), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
