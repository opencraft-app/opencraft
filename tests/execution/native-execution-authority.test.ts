import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeExecutionAuthority } from '../../apps/headless-server/src/native-execution-authority.js';

const human = (actorId = 'alice') => ({actorId, generation:1, credentialId:'login', expiresAt:100_000});
test('native notifications need an admitted submission and exact thread/turn binding', () => {
  const source = new NativeExecutionAuthority(() => {}, () => 1000);
  source.started('thread', 'input', 'turn');
  assert.throws(() => source.source('thread', {turnId:'turn'}));
  source.admit(human(), 'thread', 'input');
  assert.throws(() => source.source('thread', {inputId:'input'}));
  source.started('thread', 'input', 'turn');
  const admitted = source.source('thread', {turnId:'turn'});
  assert.equal(admitted.context.actorId, 'alice');
  assert.equal(source.source('thread', {inputId:'input'}).authorityId, admitted.authorityId);
  assert.throws(() => source.source('another', {turnId:'turn'}));
  assert.throws(() => source.source('thread', {turnId:'turn', inputId:'forged'}));
  source.started('thread', 'input', 'another-turn');
  assert.throws(() => source.source('thread', {turnId:'another-turn'}));
});
test('Host authority snapshots the submitter and rechecks revocation on every read', () => {
  let revoked = false;
  const source = new NativeExecutionAuthority(() => { if (revoked) throw Error('revoked'); }, () => 1000);
  const context = human(); source.admit(context, 'thread', 'input');
  context.actorId = 'mallory'; source.started('thread', 'input', 'turn');
  assert.equal(source.source('thread', {turnId:'turn'}).context.actorId, 'alice');
  revoked = true; assert.throws(() => source.source('thread', {turnId:'turn'}), /revoked/u);
});
test('same IDs on another physical Host do not adopt authority; disconnect and completion retire it', () => {
  const source = new NativeExecutionAuthority(() => {}, () => 1000);
  const other = new NativeExecutionAuthority(() => {}, () => 1000);
  source.admit(human(), 'thread', 'input'); source.started('thread', 'input', 'turn');
  assert.throws(() => other.source('thread', {turnId:'turn'}));
  source.ended('thread', 'turn'); assert.throws(() => source.source('thread', {turnId:'turn'}));
  source.admit(human(), 'thread', 'second'); source.started('thread', 'second', 'next');
  source.invalidate(); assert.throws(() => source.source('thread', {turnId:'next'}));
  source.started('thread', 'second', 'next'); assert.throws(() => source.source('thread', {turnId:'next'}));
});
test('steering preserves original authority, refuses another human, and releases all bound inputs', () => {
  const source = new NativeExecutionAuthority(() => {}, () => 1000, 2);
  source.admit(human(), 'thread', 'input'); source.started('thread', 'input', 'turn');
  const original = source.source('thread', {turnId:'turn'}).authorityId;
  assert.throws(() => source.admit(human('bob'), 'thread', 'steer'));
  source.admit(human(), 'thread', 'steer'); source.started('thread', 'steer', 'turn');
  assert.equal(source.source('thread', {turnId:'turn'}).authorityId, original);
  source.ended('thread', 'turn');
  source.admit(human(), 'thread', 'next'); source.admit(human(), 'thread', 'last');
});
test('bounded admission fails before dispatch and expiry cannot be extended by repeating an input', () => {
  let now = 1000;
  const source = new NativeExecutionAuthority(() => {}, () => now, 1);
  const context = {...human(), expiresAt:10 * 86_400_000};
  source.admit(context, 'thread', 'input'); source.admit(context, 'thread', 'input');
  assert.throws(() => source.admit(human(), 'thread', 'second'), /capacity/u);
  source.started('thread', 'input', 'turn'); now += 86_400_001;
  assert.throws(() => source.source('thread', {turnId:'turn'}));
  assert.throws(() => source.admit({...human(), expiresAt:now - 1}, 'thread', 'expired'));
});
test('expiry retains the old turn identity and cannot grant it to another submitter', () => {
  let now = 1000;
  const source = new NativeExecutionAuthority(() => {}, () => now);
  source.admit({...human(),expiresAt:2000}, 'thread', 'input'); source.started('thread', 'input', 'turn');
  now = 3000;
  assert.throws(() => source.admit(human('bob'), 'thread', 'steer'));
  source.admit(human(), 'thread', 'renewed'); source.started('thread', 'renewed', 'turn');
  assert.throws(() => source.source('thread', {turnId:'turn'}));
  source.ended('thread', 'turn');
  source.admit(human('bob'), 'thread', 'next'); source.started('thread', 'next', 'new-turn');
  assert.equal(source.source('thread', {turnId:'new-turn'}).context.actorId, 'bob');
});
test('explicit rejection releases pending capacity without retiring an accepted turn', () => {
  const source = new NativeExecutionAuthority(() => {}, () => 1000, 1);
  source.admit(human(), 'thread', 'rejected'); source.rejected('thread', 'rejected');
  source.admit(human(), 'thread', 'accepted'); source.started('thread', 'accepted', 'turn');
  source.rejected('thread', 'accepted');
  assert.equal(source.source('thread', {turnId:'turn'}).context.actorId, 'alice');
});
