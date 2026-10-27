import assert from 'node:assert/strict';
import test from 'node:test';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
import { generateForwardingChaos, parseForwardingTrace, simulateHostForwarding, type ForwardingEvent } from './fixtures/host-forwarding-chaos';
import { hostForwardingFixture, heldForwardingFrame, flushForwarding } from './fixtures/host-forwarding';

for (const [mutant, rule, trace] of [
  ['orphan-connect', 'FORWARD_CONNECT_SETTLEMENT', [{ type: 'open', contextual: false }, { type: 'cycle' }, { type: 'renew' }]],
  ['queued-replay', 'FORWARD_ADMISSION', [{ type: 'open', contextual: true }, { type: 'hold' }, { type: 'hold' }, { type: 'lose', state: 'closed' }]],
  ['retarget-old', 'FORWARD_WAIT_OWNERSHIP', [{ type: 'open', contextual: false }, { type: 'hold' }, { type: 'lose', state: 'closed' }, { type: 'renew' }, { type: 'hold' }, { type: 'old-result', failure: true }]],
] as const) test(`forwarding tooling control ${mutant} hits its exact rule, shrinks and normally replays`, async () => {
  const events: ForwardingEvent[] = [...trace], run = (events: readonly ForwardingEvent[]) => simulateHostForwarding(events, { mutant });
  await assert.rejects(run(events), (error: unknown) => error instanceof ChaosViolation && error.rule === rule && !error.cleanupFailure);
  const minimal = await shrinkChaosFailure(events, rule, run); assert.equal(minimal.length, events.length); await simulateHostForwarding(minimal);
});

test('forwarding oracle preserves explicit reset barriers, fresh page control and local FIFO', async () => {
  const trace: ForwardingEvent[] = [{ type: 'open', contextual: true }, { type: 'hold' }, { type: 'hold' },
    { type: 'fresh-page' }, { type: 'settle', failure: false }, { type: 'lose', state: 'connecting' },
    { type: 'renew' }, { type: 'hold' }, { type: 'old-result', failure: true }, { type: 'reset' },
    { type: 'hold' }, { type: 'renew' }, { type: 'release-close' }, { type: 'cycle' }, { type: 'renew' }, { type: 'heal' }];
  const result = await simulateHostForwarding(trace); assert.equal(result.heals, 1); assert.ok(result.nativeAdmissions >= 4); assert.ok(result.rpcFrames >= 5);
});

test('forwarding generator/parser retain all event families without hidden healing', async () => {
  const empty = await simulateHostForwarding([]); assert.equal(empty.connectIntents, 0); assert.equal(empty.nativeAdmissions, 0);
  const trace = generateForwardingChaos(0, 120); assert.equal(trace.length, 122); assert.deepEqual(trace.at(-1), { type: 'heal' });
  assert.deepEqual(generateForwardingChaos(0, 120), trace); assert.deepEqual(parseForwardingTrace(trace), trace);
  for (const invalid of [null, [{}], [{ type: 'open' }], [{ type: 'lose', state: 'open' }], [{ type: 'settle', failure: 1 }]]) assert.throws(() => parseForwardingTrace(invalid));
  for (let seed = 0; seed < 20; seed++) await simulateHostForwarding(generateForwardingChaos(seed, 120));
});

test('forwarding fixture teardown cannot admit a queued operation by releasing its predecessor', async () => {
  const f = hostForwardingFixture(), page = f.renderer();
  await page.transport.connect(); const first = page.transport.send(heldForwardingFrame('first')).catch(() => {});
  await flushForwarding(); const queued = page.transport.send(heldForwardingFrame('queued')).catch(() => {});
  await flushForwarding(); const physical = f.physical; assert.deepEqual(physical.held.map(w => w.tag), ['first']);
  await f.close(); await first; await queued; assert.deepEqual(physical.held.map(w => w.tag), ['first']);
});
