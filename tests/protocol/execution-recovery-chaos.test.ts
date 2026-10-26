import assert from "node:assert/strict";
import test from "node:test";
import { generateExecutionChaos, parseExecutionTrace, simulateExecutionRecovery, type ExecutionChaosEvent } from "./fixtures/execution-recovery-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

test("execution chaos is deterministic and exercises live questions while reads remain held", async () => {
  assert.deepEqual(generateExecutionChaos(0, 120), generateExecutionChaos(0, 120));
  const totals: Record<string, number> = {};
  for (let seed = 0; seed < 8; seed++) {
    const result = await simulateExecutionRecovery(generateExecutionChaos(seed, 120));
    for (const [key, count] of Object.entries(result.coverage)) totals[key] = (totals[key] ?? 0) + count;
  }
  for (const key of ["settings-during-read", "question-during-read", "answer-during-read", "withdraw-during-read", "effective-cancel", "number-question", "string-question", "fair-native-answer"]) assert.ok(totals[key], key);
});
for (const [mutant, type, rule] of [["buffer-native", "question", "NATIVE_REQUEST"], ["buffer-settings", "settings", "LIVE_SETTINGS"]] as const) {
  test(`execution chaos detects and shrinks ${mutant} without changing the violation`, async () => {
    const trace: ExecutionChaosEvent[] = [{ type: "pad", value: 0 }, { type: "read", value: 0 }, { type, value: 0 }, { type: "pad", value: 1 }];
    const run = (events: readonly ExecutionChaosEvent[]) => simulateExecutionRecovery(events, { mutant });
    const exact = (error: unknown) => error instanceof ChaosViolation && error.rule === rule;
    await assert.rejects(run(trace), exact);
    const minimal = await shrinkChaosFailure(trace, rule, run);
    assert.equal(minimal.length, 2); await assert.rejects(run(minimal), exact);
    await simulateExecutionRecovery(parseExecutionTrace(minimal));
  });
}
test("execution trace input rejects unknown events and non-finite identities", () => {
  assert.throws(() => parseExecutionTrace([{ type: "invented", value: 1 }]));
  assert.throws(() => parseExecutionTrace([{ type: "read", value: Infinity }]));
});
