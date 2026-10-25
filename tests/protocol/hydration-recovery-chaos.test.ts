import assert from "node:assert/strict";
import test from "node:test";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";
import { generateHydrationChaos, parseHydrationTrace, simulateHydrationRecovery, type HydrationChaosEvent } from "./fixtures/hydration-recovery-chaos";
const handoff: HydrationChaosEvent[] = [{ type: "acquire", thread: "a" }, { type: "acquire", thread: "b" }, { type: "reconnect" }];
test("composed history recovery succeeds before retired replies on the same physical Host", async () => {
  const result = await simulateHydrationRecovery(handoff);
  assert.ok(result.coverage["new-before-old-reply"]); assert.ok(result.coverage["retired-reply"]);
});
test("legacy message-window Resume also hands off without a retired reply", async () => { await simulateHydrationRecovery(handoff, { legacy: true }); });
test("a sticky Session read mutant fails the actual cross-layer handoff and shrinks to a replayable trace", async () => {
  const run = (events: readonly HydrationChaosEvent[]) => simulateHydrationRecovery(events, { mutant: "sticky-read" });
  await assert.rejects(run(handoff), error => error instanceof ChaosViolation && error.rule === "HYDRATION_HANDOFF");
  const reduced = await shrinkChaosFailure(handoff, "HYDRATION_HANDOFF", run);
  await assert.rejects(run(reduced), error => error instanceof ChaosViolation && error.rule === "HYDRATION_HANDOFF");
  await simulateHydrationRecovery(reduced);
});
for (const seed of [0, 1, 7, 42, 88, 20261026]) test(`composed hydration chaos seed ${seed}`, async () => { await simulateHydrationRecovery(generateHydrationChaos(seed)); });
test("hydration generation/replay is deterministic and rejects unknown Threads", () => {
  assert.deepEqual(generateHydrationChaos(42), generateHydrationChaos(42));
  assert.deepEqual(parseHydrationTrace(JSON.parse(JSON.stringify(handoff))), handoff);
  assert.throws(() => parseHydrationTrace([{ type: "retry", thread: "other" }]), /TRACE_SCHEMA/);
});
