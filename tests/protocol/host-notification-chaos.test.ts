import assert from 'node:assert/strict';
import test from 'node:test';
import { generateNotificationChaos, parseNotificationTrace, simulateHostNotifications, type NotificationEvent, type NotificationChaosMutant } from './fixtures/host-notification-chaos';
import { ChaosViolation, shrinkChaosFailure } from './fixtures/recovery-chaos';
test('notification chaos generation is deterministic and validates its saved schema', () => {
  assert.deepEqual(generateNotificationChaos(42, 40), generateNotificationChaos(42, 40));
  assert.deepEqual(parseNotificationTrace(generateNotificationChaos(0, 0)), generateNotificationChaos(0, 0));
  assert.throws(() => parseNotificationTrace([{ type: 'setup', lifetime: 'server' }]));
  assert.throws(() => parseNotificationTrace([{ type: 'not-an-event' }]));
});
test('empty notification input makes no native work', async () => {
  const result = await simulateHostNotifications([]); assert.equal(result.nativeAdmissions, 0); assert.equal(result.connectIntents, 0);
});
test('notification retirement survives saved provider outcomes and explicit recovery', async () => {
  for (let seed = 0; seed < 30; seed++) await simulateHostNotifications(generateNotificationChaos(seed, 80));
});
const setup: NotificationEvent = { type: 'setup', lifetime: 'server', peer: false, notice: 'reject', close: 'success' };
for (const [mutant, rule, events] of [
  ['wait-notice', 'NOTIFY_CLOSE_PROGRESS', [{ ...setup, lifetime: 'last-claim', notice: 'hold' }, { type: 'open' }, { type: 'retire' }]],
  ['duplicate-notice', 'NOTIFY_EXACT_ONCE', [setup, { type: 'open' }, { type: 'retire' }]],
  ['admit-failed', 'NOTIFY_ADMISSION_FENCE', [setup, { type: 'open' }, { type: 'retire' }, { type: 'admit' }]],
] as [NotificationChaosMutant, string, NotificationEvent[]][]) test(`notification tool control ${mutant} shrinks under its exact rule and replays normally`, async () => {
  const run = (input: readonly NotificationEvent[]) => simulateHostNotifications(input, { mutant });
  await assert.rejects(run(events), error => error instanceof ChaosViolation && error.rule === rule);
  const minimal = await shrinkChaosFailure(events, rule, run);
  await assert.rejects(run(minimal), error => error instanceof ChaosViolation && error.rule === rule);
  await simulateHostNotifications(minimal); assert.ok(minimal.length <= events.length);
});
