import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueuedSubmission } from '@opencraft/chat-runtime';
import { queuedSubmissionPresentation, visibleQueuedSubmissions } from '../../apps/workbench-web/src/queued-submission-presentation';

const base: QueuedSubmission = {
  commandId: 'command', clientMessageId: 'client', serverSubmissionId: null,
  input: [], preview: 'original message', state: 'queued', operation: 'idle',
  createdAt: 1, pausedReason: 'outbox-waiting', error: null, local: true,
};
test('local delivery distinguishes waiting, sending, unknown and failed without server controls', () => {
  for (const [state, expected] of [['queued', 'local-waiting'], ['submitting', 'local-sending'], ['unknown', 'local-unconfirmed'], ['failed', 'local-failed']] as const) {
    const row = queuedSubmissionPresentation({ ...base, state }, true);
    assert.equal(row.deliveryState, expected);
    assert.equal(row.actionable, false);
    assert.equal(row.resumable, false);
    assert.equal(row.reorderable, false);
    assert.equal(row.dismissible, state === 'queued' || state === 'failed');
  }
  assert.equal(queuedSubmissionPresentation({ ...base, state: 'submitting' }, false).pausedReason, 'Sending…');
});
test('server queue retains authoritative permissions and per-message recovery', () => {
  const row = queuedSubmissionPresentation({ ...base, local: false, serverSubmissionId: 'server', pausedReason: 'user-stopped' }, true);
  assert.equal(row.deliveryState, 'server-queue');
  assert.equal(row.actionable, true);
  assert.equal(row.deletable, true);
  assert.equal(row.reorderable, true);
  assert.equal(row.resumable, true);
  assert.equal(queuedSubmissionPresentation({ ...base, local: false, pausedReason: 'session-tools-recovering' }, false).resumable, false);
});


test('uncertain local input stays visible when no transcript or recovery projection is available', () => {
  const unknown = { ...base, state: 'unknown' as const, pausedReason: 'outbox-unconfirmed' };
  assert.deepEqual(visibleQueuedSubmissions([unknown], null), [unknown]);
  const row = queuedSubmissionPresentation(unknown, false);
  assert.equal(row.dismissible, false);
  assert.equal(row.actionable, false);
  assert.equal(row.deliveryState, 'local-unconfirmed');
});
