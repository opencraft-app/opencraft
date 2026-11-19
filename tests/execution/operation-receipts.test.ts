import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationReceipts } from '../../apps/codex-core/src/operation-receipts.js';

test('a failed transport subscriber neither loses the receipt nor skips later subscribers', () => {
  for (const complete of [true, false]) {
    const receipts = new OperationReceipts(), owner = {}, delivered: unknown[] = [];
    receipts.subscribe('operation', 'intent', { owner, id: 1, deliver() { throw Error('disconnected'); } });
    receipts.subscribe('operation', 'intent', { owner, id: 2, deliver: reply => delivered.push(reply) });
    const reply = complete ? { result: 'created' } : { error: { resultUnknown: true } };
    if (complete) receipts.complete('operation', reply); else receipts.uncertain('operation', reply);
    assert.deepEqual(delivered, [reply]);
    assert.deepEqual(receipts.get('operation')?.reply, reply);
    assert.equal(receipts.acknowledge('operation'), complete);
  }
});

test('uncertainty is not settlement and a confirmed late result replaces it without replaying execution', () => {
  const receipts = new OperationReceipts(), replies: unknown[] = [];
  const subscribe = (id: number) => receipts.subscribe('operation', 'intent', { owner: {}, id, deliver: reply => replies.push(reply) });
  assert.equal(subscribe(1), 'created');
  receipts.uncertain('operation', { error: 'unknown' });
  assert.equal(receipts.acknowledge('operation'), false);
  assert.equal(subscribe(2), 'existing');
  receipts.complete('operation', { result: 'confirmed' });
  assert.equal(subscribe(3), 'existing');
  assert.deepEqual(replies, [{ error: 'unknown' }, { error: 'unknown' }, { result: 'confirmed' }]);
  receipts.complete('operation', { result: 'must-not-replace-terminal-receipt' });
  assert.deepEqual(receipts.get('operation')?.reply, { result: 'confirmed' });
  assert.equal(receipts.acknowledge('operation'), true); assert.equal(receipts.size, 0);
});

test('owner/id deduplication, detached subscribers and admission limits are independent of receipt lifetime', () => {
  const receipts = new OperationReceipts(1, 2), owner = {}, subscriber = { owner, id: 1, deliver() {} };
  receipts.subscribe('one', 'intent', subscriber);
  receipts.subscribe('one', 'intent', subscriber);
  receipts.subscribe('one', 'intent', { ...subscriber, id: 2 });
  assert.throws(() => receipts.subscribe('one', 'intent', { ...subscriber, id: 3 }), /subscriber limit/);
  assert.throws(() => receipts.subscribe('one', 'different intent', subscriber), /reused/);
  assert.throws(() => receipts.subscribe('two', 'intent', subscriber), /receipt limit/);
  receipts.detach(owner); assert.equal(receipts.size, 1);
  assert.equal(receipts.subscribe('one', 'intent', { ...subscriber, id: 3 }), 'existing');
  assert.equal(receipts.acknowledge('one'), false);
  receipts.complete('one', { result: true });
  assert.equal(receipts.acknowledge('one'), true);
  assert.equal(receipts.subscribe('two', 'intent', subscriber), 'created');
});
