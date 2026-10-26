import test from "node:test";
import assert from "node:assert/strict";
import { generateRecordingChaos, parseRecordingTrace, simulateRecordingLifetime, type RecordingEvent, type RecordingMutant } from "./fixtures/recording-lifetime-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("recording chaos composes real wrapper, Client and native Memory with explicit recovery", async () => {
  for (let seed = 0; seed < 24; seed++) { const r = await simulateRecordingLifetime(generateRecordingChaos(seed)); assert.equal(r.events, 121); assert.equal(r.connectIntents, r.connectSettled); }
});
const controls: { mutant: RecordingMutant; rule: string; events: RecordingEvent[] }[] = [
  { mutant: "sample-echo", rule: "RECORDING_STATUS_SOURCE", events: [{ type: "connect" }] },
  { mutant: "retarget-cleanup", rule: "RECORDING_CONNECT_PROGRESS", events: [{ type: "connect" }, { type: "renew" }] },
  { mutant: "orphan-rpc", rule: "RECORDING_RPC_SETTLEMENT", events: [{ type: "connect" }, { type: "echo" }] },
];
for (const c of controls) test(`recording ${c.mutant} shrinks its exact rule and normally replays`, async () => {
  const run = (trace: readonly RecordingEvent[]) => simulateRecordingLifetime(trace, { mutant: c.mutant });
  await assert.rejects(run(c.events), e => e instanceof ChaosViolation && e.rule === c.rule);
  const minimal = await shrinkChaosFailure(c.events, c.rule, run);
  assert.ok(minimal.length > 0 && minimal.length <= c.events.length);
  await assert.rejects(run(minimal), e => e instanceof ChaosViolation && e.rule === c.rule && !e.cleanupFailure);
  await simulateRecordingLifetime(minimal);
});
test("recording empty input creates no native connection or hidden cleanup probe", async () => {
  const r = await simulateRecordingLifetime([]); assert.equal(r.nativeAdmissions, 0); assert.equal(r.recordedFrames, 0);
});
test("renew from idle cannot arm a reentrant connection on a later explicit close", async () => {
  await simulateRecordingLifetime([{ type: "renew" }, { type: "close" }, { type: "echo" }]);
});
test("recording heal is saved and proves a usable RPC after initialization", async () => {
  const trace = generateRecordingChaos(0, 0); assert.deepEqual(trace, [{ type: "heal" }]);
  const r = await simulateRecordingLifetime(trace); assert.equal(r.rpcFrames, 1); assert.equal(r.coverage["explicit-heal"], 1);
});
test("recording parser rejects malformed input", () => {
  for (const input of [null, {}, [{ type: "unknown" }], [{ type: "connect", pick: -1 }]]) assert.throws(() => parseRecordingTrace(input));
});
