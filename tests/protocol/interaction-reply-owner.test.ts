import assert from 'node:assert/strict';
import test from 'node:test';
import { HostInteractions } from '../../packages/app-host-server/src/interactions';
import type { InteractionSourceRequest } from '@opencraft/appserver-protocol';

function gate() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const source = (id = 'native', state?: InteractionSourceRequest['__opencraftInteractionState']): InteractionSourceRequest => ({ id,
  method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', questions: [] },
  __opencraftInteractionKey: 'lifetime', ...(state ? { __opencraftInteractionState: state } : {}),
});
for (const next of [false, true]) for (const sameSource of [false, true]) {
  test(`old failure preserves replay state (new answer=${next}, same source=${sameSource})`, async () => {
    const h = new HostInteractions(), origin = source('old', 'pending'), id = h.capture(origin);
    const oldGate = gate(), nextGate = gate(), writes: (string | number)[] = [], error = Error('old write failed');
    let notices = 0; h.subscribe(() => { notices++; });
    const old = h.respond('thread', id, 'same-submission', { answer: 1 }, s => { writes.push(s.id); return oldGate.promise; });
    const rejected = assert.rejects(old, e => e === error);
    h.capture(sameSource ? origin : source('new', 'pending'));
    const current = next ? h.respond('thread', id, 'same-submission', { answer: 1 }, s => { writes.push(s.id); return nextGate.promise; }) : undefined;
    const before = h.snapshot('thread', true), count = notices;
    oldGate.reject(error); await rejected;
    assert.deepEqual(h.snapshot('thread', true), before, 'retired attempt must not publish or replace current state');
    assert.equal(notices, count); assert.deepEqual(writes, next ? ['old', sameSource ? 'old' : 'new'] : ['old']);
    nextGate.resolve(); if (current) assert.equal(await current, 'submitted');
    assert.equal(h.snapshot('thread', true).requests[0]!.state, next ? 'responding' : 'pending');
  });
}
for (const replay of [false, true]) test(`current failure remains unconfirmed (responding replay=${replay})`, async () => {
  const h = new HostInteractions(), id = h.capture(source()), held = gate(), error = Error('current failure');
  const result = assert.rejects(h.respond('thread', id, 'answer', {}, () => held.promise), e => e === error);
  if (replay) h.capture(source('replacement-route', 'responding'));
  const revision = h.snapshot('thread', true).revision;
  held.reject(error); await result;
  assert.equal(h.snapshot('thread', true).requests[0]!.state, 'unconfirmed');
  assert.equal(h.snapshot('thread', true).revision, revision + 1);
});
for (const clear of [false, true]) test(`retired entry cannot be revived (clear=${clear})`, async () => {
  const h = new HostInteractions(), id = h.capture(source()), held = gate();
  const result = assert.rejects(h.respond('thread', id, 'answer', {}, () => held.promise), /late/);
  if (clear) { h.clear(); h.capture(source()); } else h.resolveNative('native', 'thread');
  const before = h.snapshot('thread', true);
  held.reject(Error('late')); await result; assert.deepEqual(h.snapshot('thread', true), before);
});
for (const conflict of [false, true]) test(`validation reentry keeps the first admitted answer (conflict=${conflict})`, async () => {
  const h = new HostInteractions(), id = h.capture(source()), writes: string[] = [];
  let peer!: Promise<unknown>;
  const outer = h.respond('thread', id, 'outer', { answer: 1 }, async () => { writes.push('outer'); }, () => {
    peer = h.respond('thread', id, conflict ? 'outer' : 'peer', { answer: 2 }, async () => { writes.push('peer'); });
  });
  if (conflict) await assert.rejects(outer, e => (e as { domainData?: { code: string } }).domainData?.code === 'RESPONSE_CONFLICT');
  else assert.equal(await outer, 'already-submitted');
  assert.equal(await peer, 'submitted'); assert.deepEqual(writes, ['peer']);
  assert.equal(h.snapshot('thread', true).requests[0]!.state, 'responding');
});
test('validation failure does not occupy admission', async () => {
  const h = new HostInteractions(), id = h.capture(source()), before = h.snapshot('thread', true);
  await assert.rejects(h.respond('thread', id, 'bad', {}, async () => assert.fail(), () => { throw Error('invalid'); }), /invalid/);
  assert.deepEqual(h.snapshot('thread', true), before);
  assert.equal(await h.respond('thread', id, 'valid', {}, async () => {}), 'submitted');
});
test('validation retirement does not publish to a replacement entry', async () => {
  const h = new HostInteractions(), id = h.capture(source()); let revision = 0;
  const result = h.respond('thread', id, 'old', {}, async () => assert.fail(), () => {
    h.clear(); h.capture(source()); revision = h.snapshot('thread', true).revision;
  });
  assert.equal(await result, 'resolved'); assert.equal(h.snapshot('thread', true).revision, revision);
  assert.equal(h.snapshot('thread', true).requests[0]!.state, 'pending');
});
