import test from "node:test";
import assert from "node:assert/strict";
import { generateRetirementChaos, parseRetirementTrace, simulateClientRetirement, type RetirementEvent, type RetirementMutant } from "./fixtures/client-retirement-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("retirement chaos exercises actual Client/Memory recovery and held RPC ownership", async () => {
  for (let seed = 0; seed < 24; seed++) { const result = await simulateClientRetirement(generateRetirementChaos(seed)); assert.equal(result.events, 121); assert.equal(result.connectIntents, result.connectSettled); }
});

const controls: { mutant: RetirementMutant; rule: string; events: RetirementEvent[] }[] = [
  { mutant: "orphan-connect", rule: "RETIREMENT_CONNECT_PROGRESS", events: [{ type: "connect" }] },
  { mutant: "rearm-old-loss", rule: "RETIREMENT_CONNECT_PROGRESS", events: [{ type: "connect" }, { type: "renew" }] },
  { mutant: "drop-current-loss", rule: "RETIREMENT_CURRENT_LOSS", events: [{ type: "new-loss" }] },
  { mutant: "replay-request", rule: "RETIREMENT_WIRE_ONCE", events: [{ type: "connect" }, { type: "hold" }, { type: "renew" }] },
];
for (const c of controls) test(`retirement chaos ${c.mutant} fails its exact rule and replays normally`, async () => {
  const run = (events: readonly RetirementEvent[]) => simulateClientRetirement(events, { mutant: c.mutant });
  await assert.rejects(run(c.events), error => error instanceof ChaosViolation && error.rule === c.rule);
  const minimal = await shrinkChaosFailure(c.events, c.rule, run);
  assert.ok(minimal.length > 0 && minimal.length <= c.events.length);
  await assert.rejects(run(minimal), error => error instanceof ChaosViolation && error.rule === c.rule && error.cleanupFailure === undefined);
  await simulateClientRetirement(minimal);
});

test("retirement empty trace has no hidden native connect", async () => {
  const result = await simulateClientRetirement([]); assert.equal(result.nativeAdmissions, 0); assert.equal(result.connectIntents, 0);
});
test("retirement heal is explicit and performs a usable initialization", async () => {
  const trace = generateRetirementChaos(0, 0); assert.deepEqual(trace, [{ type: "heal" }]);
  const result = await simulateClientRetirement(parseRetirementTrace(trace)); assert.equal(result.nativeInitializations, 1); assert.equal(result.coverage["explicit-heal"], 1);
});
test("retirement trace parser rejects malformed inputs", () => {
  for (const value of [null, {}, [{ type: "unknown" }], [{ type: "connect", pick: -1 }]]) assert.throws(() => parseRetirementTrace(value));
});
