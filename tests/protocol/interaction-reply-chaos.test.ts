import assert from 'node:assert/strict';
import test from 'node:test';
import { generateReplyChaos, parseReplyTrace, simulateReplyOwners, type ReplyEvent, type ReplyMutant } from './fixtures/interaction-reply-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';

test('reply traces are deterministic and reject malformed saved inputs', () => {
  assert.deepEqual(generateReplyChaos(42, 100), generateReplyChaos(42, 100));
  assert.deepEqual(parseReplyTrace(generateReplyChaos(0, 0)), generateReplyChaos(0, 0));
  for (const e of [{ type: 'finish', ok: true }, { type: 'answer', submission: 'a', payload: 2, validation: 'none' }, { type: 'capture', state: 'keep' }])
    assert.throws(() => parseReplyTrace([e]));
});
test('empty reply traces perform no writes', async () => { assert.equal((await simulateReplyOwners([])).nativeReplies, 0); });
test('repeated producer replay, validation and late write outcomes preserve their captured owners', async () => {
  for (let seed = 0; seed < 60; seed++) await simulateReplyOwners(generateReplyChaos(seed, 120));
});
const capture: ReplyEvent = { type: 'capture', state: 'pending', same: false };
const answer: ReplyEvent = { type: 'answer', submission: 'a', payload: 0, validation: 'none' };
for (const [mutant, rule, events] of [
  ['late-state', 'REPLY_CURRENT_STATE', [capture, answer, capture, { type: 'finish', target: 'oldest', ok: false }]],
  ['duplicate-write', 'REPLY_NATIVE_ADMISSION', [capture, { ...answer, validation: 'peer' }]],
  ['drop-error', 'REPLY_CALLER_OUTCOME', [capture, answer, { type: 'finish', target: 'oldest', ok: false }]],
] as [ReplyMutant, string, ReplyEvent[]][]) test(`reply control ${mutant} shrinks under the same rule and replays normally`, async () => {
  const run = (input: readonly ReplyEvent[]) => simulateReplyOwners(input, { mutant });
  await assert.rejects(run(events), e => e instanceof ChaosViolation && e.rule === rule);
  const minimal = await shrinkChaosFailure(events, rule, run);
  await assert.rejects(run(minimal), e => e instanceof ChaosViolation && e.rule === rule);
  await simulateReplyOwners(minimal); assert.ok(minimal.length <= events.length);
});
