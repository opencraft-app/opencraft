import test from "node:test";
import assert from "node:assert/strict";
import { generateReplayChaos, parseReplayTrace, simulateReplayLifetime, type ReplayEvent, type ReplayMutant } from "./fixtures/replay-lifetime-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";
test("replay chaos drives actual Replay with saved clock inputs and an independent tape oracle", async () => {
  for (let seed = 0; seed < 24; seed++) { const r = await simulateReplayLifetime(generateReplayChaos(seed)); assert.equal(r.events, 121); assert.equal(r.connectIntents, r.connectSettled); assert.equal(r.sendIntents, r.sendSettled); }
});
const controls: { mutant: ReplayMutant; rule: string; events: ReplayEvent[] }[] = [
  { mutant: "orphan-connect", rule: "REPLAY_CONNECT_PROGRESS", events: [{ type: "connect" }] },
  { mutant: "duplicate-frame", rule: "REPLAY_FRAME_SEQUENCE", events: [{ type: "heal" }] },
  { mutant: "cursor-drift", rule: "REPLAY_CURSOR_OWNERSHIP", events: [{ type: "connect" }, { type: "send" }, { type: "close" }, { type: "release" }] },
];
for (const c of controls) test(`replay ${c.mutant} fails its precise rule, shrinks and replays normally`, async () => {
  const run = (trace: readonly ReplayEvent[]) => simulateReplayLifetime(trace, { mutant: c.mutant });
  await assert.rejects(run(c.events), e => e instanceof ChaosViolation && e.rule === c.rule);
  const minimal = await shrinkChaosFailure(c.events, c.rule, run); assert.ok(minimal.length > 0 && minimal.length <= c.events.length);
  await assert.rejects(run(minimal), e => e instanceof ChaosViolation && e.rule === c.rule && !e.cleanupFailure);
  await simulateReplayLifetime(minimal);
});
test("replay empty trace has no native connect, send or clock wait", async () => {
  const r = await simulateReplayLifetime([]); assert.equal(r.connectIntents, 0); assert.equal(r.sendIntents, 0); assert.equal(r.clockWaits, 0);
});
test("one replay seed combines clock, cancellation and observer reentry families", () => {
  const types = new Set(generateReplayChaos(0).map(e => e.type));
  for (const kind of ["connect", "send", "close", "release", "reject-clock", "abort-send", "message-noise", "frame-close"] as const) assert.ok(types.has(kind), kind);
});
test("replay explicit heal proves progress before releasing an old pending clock", async () => {
  const r = await simulateReplayLifetime([{ type: "connect" }, { type: "send" }, { type: "close" }, { type: "heal" }]);
  assert.equal(r.coverage["healed-with-held-retired-clock"], 1); assert.equal(r.messageDeliveries, 1); assert.equal(r.clockReleases, 1);
});
test("replay same-stack connect and send cannot join a finished empty drain", async () => {
  const r = await simulateReplayLifetime([{ type: "connect-send" }, { type: "release" }]);
  assert.equal(r.messageDeliveries, 1); assert.equal(r.sendSettled, 1); assert.equal(r.clockWaits, 1);
});
test("replay parser rejects malformed events", () => {
  for (const value of [null, {}, [{ type: "unknown" }], [{ type: "send", pick: -1 }]]) assert.throws(() => parseReplayTrace(value));
});
