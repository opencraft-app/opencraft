import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimelineSnapshot } from '@opencraft/chat-core';
import type { PendingSubmission, QueuedSubmission } from '@opencraft/chat-runtime';
import { submissionRecoveryPresentation } from '../../apps/workbench-web/src/submission-recovery-presentation';

const pending = { commandId: 'one', clientMessageId: 'message-one', preview: 'same text', state: 'unknown' } as PendingSubmission;
const queue = (patch: Partial<QueuedSubmission>) => ({ ...pending, serverSubmissionId: null,
  pausedReason: null, ...patch } as QueuedSubmission);
const timeline = (id: string) => ({ frames: [{ blocks: [{ type: 'user-message', clientId: id, message: 'same text' }] }] } as TimelineSnapshot);

test('recovery belongs to the exact message once, including pending-to-queue handoff', () => {
  const view = submissionRecoveryPresentation([pending], [queue({})], timeline('message-one'));
  assert.equal(view.byClientId.size, 1);
  assert.equal(view.byClientId.get('message-one')?.commandId, 'one');
  assert.deepEqual(view.detached, []);
  const other = submissionRecoveryPresentation([pending], [], timeline('another-message'));
  assert.equal(other.byClientId.size, 0, 'same text is not identity');
  assert.equal(other.detached.length, 1);
});

test('hidden history retains a recovery entry; confirmed or server-owned items do not get local actions', () => {
  const view = submissionRecoveryPresentation([], [queue({}), queue({ commandId: 'server', serverSubmissionId: 'server-one' }),
    queue({ commandId: 'confirmed', state: 'queued' }), queue({ commandId: 'failed', state: 'failed', pausedReason: 'outbox-failed' })], null);
  assert.deepEqual(view.detached.map(row => row.commandId), ['one', 'failed']);
  assert.equal(submissionRecoveryPresentation([{ ...pending, state: 'accepted' }], [], timeline('message-one')).byClientId.size, 0);
});
