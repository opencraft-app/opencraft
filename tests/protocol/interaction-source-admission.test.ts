import assert from 'node:assert/strict';
import test from 'node:test';
import { HostInteractions } from '../../packages/app-host-server/src/interactions';
import type { InteractionSourceRequest } from '@opencraft/appserver-protocol';

const source = (id = 'native', threadId = 'thread'): InteractionSourceRequest => ({ id,
  method: 'item/tool/requestUserInput', params: { threadId, turnId: 'turn', questions: [] },
  __opencraftInteractionKey: `lifetime:${threadId}`,
});
const unavailable = (e: unknown) => (e as { domainData?: { code: string } }).domainData?.code === 'SOURCE_UNAVAILABLE';
for (const boundary of ['validation', 'fingerprint'] as const) test(`source revocation during ${boundary} rejects before claiming or publishing`, async () => {
  const h = new HostInteractions(), original = source(), id = h.capture(original);
  let writes = 0, notices = 0; h.subscribe(() => { notices++; });
  const revoke = () => h.markSourceUnavailable('thread');
  const result = boundary === 'fingerprint' ? { get answer() { revoke(); return 1; } } : { answer: 1 };
  const rejected = h.respond('thread', id, 'invalid', result, async () => { writes++; }, boundary === 'validation' ? revoke : undefined);
  await assert.rejects(rejected, unavailable);
  const blocked = h.snapshot('thread', true);
  assert.equal(blocked.requests[0]!.state, 'pending'); assert.equal(blocked.requests[0]!.canRespond, false);
  assert.equal(blocked.revision, 2); assert.equal(notices, 1); assert.equal(writes, 0);
  h.capture({ ...original, id: 'replayed-native' });
  assert.equal(h.snapshot('thread', true).requests[0]!.state, 'pending');
  assert.equal(await h.respond('thread', id, 'valid', { answer: 2 }, async s => { assert.equal(s.id, 'replayed-native'); writes++; }), 'submitted');
  assert.equal(writes, 1);
});
test('an unavailable source rejects before executing fingerprint getters or validation', async () => {
  const h = new HostInteractions(), id = h.capture(source()); h.markSourceUnavailable();
  const before = h.snapshot('thread', true);
  await assert.rejects(h.respond('thread', id, 'invalid', { get answer() { return assert.fail('fingerprint ran'); } },
    async () => assert.fail('writer ran'), () => assert.fail('validator ran')), unavailable);
  assert.deepEqual(h.snapshot('thread', true), before);
});
test('revoking another Thread does not revoke the admitted source', async () => {
  const h = new HostInteractions(), id = h.capture(source()); h.capture(source('peer-native', 'peer'));
  let writes = 0;
  assert.equal(await h.respond('thread', id, 'answer', {}, async () => { writes++; }, () => h.markSourceUnavailable('peer')), 'submitted');
  assert.equal(writes, 1); assert.equal(h.snapshot('thread', true).requests[0]!.canRespond, true);
  assert.equal(h.snapshot('peer', true).requests[0]!.state, 'pending'); assert.equal(h.snapshot('peer', true).requests[0]!.canRespond, false);
});
test('an admitted peer retains its answer when validation subsequently revokes the source', async () => {
  const h = new HostInteractions(), id = h.capture(source()); let writes = 0, peer!: Promise<unknown>;
  let reject!: (e: Error) => void; const held = new Promise<void>((_a, b) => { reject = b; });
  await assert.rejects(h.respond('thread', id, 'outer', {}, async () => { writes++; }, () => {
    peer = h.respond('thread', id, 'peer', { answer: 1 }, async () => { writes++; await held; });
    h.markSourceUnavailable();
  }), unavailable);
  const before = h.snapshot('thread', true);
  assert.equal(before.requests[0]!.state, 'responding'); assert.equal(before.revision, 3); assert.equal(writes, 1);
  const error = Error('peer failed'), failed = assert.rejects(peer, e => e === error); reject(error); await failed;
  assert.equal(h.snapshot('thread', true).requests[0]!.state, 'unconfirmed'); assert.equal(h.snapshot('thread', true).requests[0]!.canRespond, false);
});
test('entry retirement wins over the availability of a replacement entry', async () => {
  const h = new HostInteractions(), id = h.capture(source()); let before!: ReturnType<HostInteractions['snapshot']>;
  assert.equal(await h.respond('thread', id, 'old', {}, async () => assert.fail('old writer ran'), () => {
    h.clear(); h.capture(source()); h.markSourceUnavailable(); before = h.snapshot('thread', true);
  }), 'resolved');
  assert.deepEqual(h.snapshot('thread', true), before);
});
test('validation throws its original error without creating an answer after revocation', async () => {
  const h = new HostInteractions(), id = h.capture(source()), error = Error('invalid answer');
  await assert.rejects(h.respond('thread', id, 'invalid', {}, async () => assert.fail(), () => {
    h.markSourceUnavailable(); throw error;
  }), e => e === error);
  assert.equal(h.snapshot('thread', true).revision, 2); assert.equal(h.snapshot('thread', true).requests[0]!.state, 'pending');
});
test('producer replay during validation can restore the source before admission', async () => {
  const h = new HostInteractions(), original = source(), id = h.capture(original); let route: unknown;
  assert.equal(await h.respond('thread', id, 'answer', {}, async s => { route = s.id; }, () => {
    h.markSourceUnavailable(); h.capture({ ...original, id: 'new-native' });
  }), 'submitted');
  assert.equal(route, 'new-native'); assert.equal(h.snapshot('thread', true).requests[0]!.state, 'responding');
});
