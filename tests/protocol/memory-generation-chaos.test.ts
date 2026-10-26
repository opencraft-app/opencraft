import test from "node:test";
import assert from "node:assert/strict";
import { generateMemoryChaos, parseMemoryTrace, simulateMemoryGenerations, type MemoryChaosEvent, type MemoryChaosMutant } from "./fixtures/memory-generation-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("memory chaos checks actual hook, queued-frame and retired-peer interleavings", async () => {
  for (let seed = 0; seed < 24; seed++) {
    const result = await simulateMemoryGenerations(generateMemoryChaos(seed));
    assert.equal(result.events, 121); assert.equal(result.connectIntents, result.connectSettled);
  }
});

const controls: { mutant: MemoryChaosMutant; rule: string; events: MemoryChaosEvent[] }[] = [
  { mutant: "orphan-connect", rule: "MEMORY_CONNECT_SETTLEMENT", events: [{ type: "begin" }, { type: "admit" }] },
  { mutant: "stale-peer", rule: "MEMORY_FRAME_OWNER", events: [
    { type: "begin" }, { type: "admit" }, { type: "close" }, { type: "begin" }, { type: "admit", target: "current" }, { type: "frame", target: "old" }, { type: "flush" },
  ] },
  { mutant: "cleanup-retarget", rule: "MEMORY_STATUS_OWNER", events: [
    { type: "begin" }, { type: "admit" }, { type: "close" }, { type: "begin" }, { type: "admit", target: "current" }, { type: "ack", target: "old" },
  ] },
];
for (const control of controls) test(`memory chaos ${control.mutant} fails its precise rule and replays without corruption`, async () => {
  const run = (events: readonly MemoryChaosEvent[]) => simulateMemoryGenerations(events, { mutant: control.mutant });
  await assert.rejects(run(control.events), error => error instanceof ChaosViolation && error.rule === control.rule);
  const minimal = await shrinkChaosFailure(control.events, control.rule, run);
  assert.ok(minimal.length > 0 && minimal.length <= control.events.length);
  await assert.rejects(run(minimal), error => error instanceof ChaosViolation && error.rule === control.rule && error.cleanupFailure === undefined);
  await simulateMemoryGenerations(minimal);
});

test("memory chaos empty input has no hidden allocation or healing", async () => {
  const result = await simulateMemoryGenerations([]);
  assert.equal(result.connectIntents, 0); assert.equal(result.nativeAdmissions, 0); assert.equal(result.nativeEvents, 0);
});

test("memory chaos healing is explicit in the saved trace", async () => {
  const trace = generateMemoryChaos(7, 0); assert.deepEqual(trace, [{ type: "heal" }]);
  const result = await simulateMemoryGenerations(parseMemoryTrace(trace));
  assert.equal(result.coverage["explicit-heal"], 1); assert.equal(result.nativeAdmissions, 1); assert.equal(result.messageDeliveries, 1);
  const blockedOld = await simulateMemoryGenerations([{ type: "begin" }, { type: "heal" }]);
  assert.equal(blockedOld.coverage["healed-with-retired-admission"], 1);
});

test("memory chaos rejects malformed owner and event fields", () => {
  for (const value of [null, {}, [{ type: "unknown" }], [{ type: "begin", pick: -1 }], [{ type: "frame", target: "foreign" }]]) {
    assert.throws(() => parseMemoryTrace(value));
  }
});
