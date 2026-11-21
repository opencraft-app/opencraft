import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountEnvironment } from '@opencraft/execution-environment/account-environment';
import { EmployeeGitVaultStore } from '@opencraft/execution-environment/employee-git-vault-store';
import { ExecutionEnvironmentRuntime } from '@opencraft/execution-environment';
import { ExecutionEnvironmentTransport } from '../../apps/headless-server/src/execution-environment-transport.js';
import type { TransportSubmissionContext } from '../../packages/appserver-client/src/transport.js';

const context = (subject: string): TransportSubmissionContext => ({ sender: null,
  executionPrincipal: { provider: 'employee', subject }, validUntil: Date.now() + 60_000 });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-env-owner-'));
  const vault = new EmployeeGitVaultStore(directory), runtime = new ExecutionEnvironmentRuntime(directory, vault);
  const environment = new AccountEnvironment(vault);
  environment.replace('employee:alice', { projectId: null }, 0, [{ name: 'SERVICE_KEY', value: 'synthetic-alice', secret: true }]);
  environment.replace('employee:bob', { projectId: null }, 0, [{ name: 'SERVICE_KEY', value: 'synthetic-bob', secret: true }]);
  t.after(async () => { runtime.close(); vault.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, vault, runtime, environment };
}

test('new tasks retain their creator across reopen, edits and attempts by another person', async t => {
  const f = await fixture(t), scope = f.runtime.scope(context('alice'), 'host', {});
  f.runtime.bindCreator(scope, 'task');
  f.runtime.bindCreator(scope, 'task');
  const peer = new ExecutionEnvironmentRuntime(f.directory, f.vault);
  const admitted = () => peer.scope(context('alice'), 'host', { threadId: 'task' });
  assert.equal(peer.snapshot(admitted()).overlay().SERVICE_KEY, 'synthetic-alice');
  f.environment.replace('employee:alice', { projectId: null }, 1, [{ name: 'SERVICE_KEY', value: 'synthetic-rotated', secret: true }]);
  assert.equal(peer.snapshot(admitted()).overlay().SERVICE_KEY, 'synthetic-rotated');
  assert.equal(peer.snapshot(peer.scope(context('bob'), 'host', { threadId: 'task' })).overlay().SERVICE_KEY, 'synthetic-bob');
  assert.throws(() => peer.scope({ sender: null }, 'host', { threadId: 'task' }), { status: 403 });
  assert.throws(() => peer.bindCreator({ ...scope, account: 'employee:bob' }, 'task'), { status: 409 });
  assert.equal(peer.snapshot({ ...scope, threadId: 'task', account: 'employee:bob' }).overlay().SERVICE_KEY, 'synthetic-bob');
  assert.deepEqual(peer.snapshot(peer.execution('host', 'task')).overlay(), {});
  f.environment.replace('employee:alice', { projectId: null }, 2, []);
  assert.deepEqual(peer.snapshot(admitted()).overlay(), {});
  assert.deepEqual(peer.creator('host', 'task'), { account: 'employee:alice' });
});

test('creation replies bind before publication; reads, failures and forks cannot borrow another creator', async t => {
  const f = await fixture(t), listeners = new Set<(frame: string) => void>(), sent: any[] = [], replies: any[] = [];
  const inner = { status: { state: 'open' as const }, async connect() {}, async close() {},
    subscribeStatus() { return () => {}; }, subscribeMessage(fn: (frame: string) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async send(frame: string) { sent.push(JSON.parse(frame)); }, async sendWithContext(frame: string) { sent.push(JSON.parse(frame)); } };
  const transport = new ExecutionEnvironmentTransport(inner, f.runtime, 'host');
  t.after(() => transport.close());
  transport.subscribeMessage(frame => replies.push(JSON.parse(frame)));
  const reply = (value: unknown) => { for (const fn of listeners) fn(JSON.stringify(value)); };
  await transport.sendWithContext(JSON.stringify({ id: 1, method: 'thread/start', params: {} }), context('alice'));
  reply({ id: 1, result: { thread: { id: 'task', projectId: null } } });
  assert.deepEqual(f.runtime.creator('host', 'task'), { account: 'employee:alice' });
  await transport.sendWithContext(JSON.stringify({ id: 2, method: 'thread/read', params: { threadId: 'task' } }), context('bob'));
  reply({ id: 2, result: { thread: { id: 'task', projectId: null } } });
  await transport.sendWithContext(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: 'task' } }), context('bob'));
  assert.equal(sent.some(row => row.id === 3), true);
  for (const method of ['turn/steer', 'thread/shellCommand', 'thread/queue/update', 'thread/goal/set', 'review/start']) {
    await transport.sendWithContext(JSON.stringify({ id: method, method, params: { threadId: 'task' } }), context('bob'));
    assert.equal(sent.some(row => row.id === method), true);
  }
  await transport.sendWithContext(JSON.stringify({ id: 'view', method: 'thread/resume', params: { threadId: 'task' } }), context('bob'));
  assert.equal(sent.at(-1).params.__opencraftEnvironment, undefined);
  await transport.sendWithContext(JSON.stringify({ id: 4, method: 'thread/fork', params: { threadId: 'task' } }), context('bob'));
  reply({ id: 4, result: { thread: { id: 'copy', projectId: null } } });
  assert.deepEqual(f.runtime.creator('host', 'copy'), { account: 'employee:bob' });
  assert.equal(f.runtime.snapshot(f.runtime.scope(context('bob'), 'host', { threadId: 'copy' })).overlay().SERVICE_KEY, 'synthetic-bob');
  await transport.sendWithContext(JSON.stringify({ id: 5, method: 'thread/start', params: {} }), context('alice'));
  reply({ id: 5, error: { code: -32602, message: 'rejected' }, result: { thread: { id: 'failed' } } });
  assert.equal(f.runtime.creator('host', 'failed'), null);
  assert.equal(JSON.stringify(replies).includes('synthetic-'), false);
  // A storage/identity conflict is rejected identically for every subscriber;
  // consuming the pending record must not let a second listener see success.
  const secondary: any[] = [];
  transport.subscribeMessage(frame => secondary.push(JSON.parse(frame)));
  await transport.sendWithContext(JSON.stringify({ id: 6, method: 'thread/start', params: {} }), context('bob'));
  reply({ id: 6, result: { thread: { id: 'task' } } });
  assert.equal(replies.at(-1).error.message, 'Unable to bind task credentials');
  assert.deepEqual(secondary.at(-1), replies.at(-1));
  assert.equal(secondary.at(-1).result, undefined);
});

test('later authenticated participation leaves anonymous creation provenance unchanged', async t => {
  const f = await fixture(t);
  f.runtime.bindCreator(f.runtime.scope({ sender: null }, 'host', {}), 'anonymous');
  assert.equal(f.runtime.snapshot(f.runtime.scope(context('alice'), 'host', { threadId: 'anonymous' })).overlay().SERVICE_KEY, 'synthetic-alice');
  assert.deepEqual(f.runtime.creator('host', 'anonymous'), { account: null });
  assert.deepEqual(f.runtime.snapshot(f.runtime.scope({ sender: null }, 'host', { threadId: 'anonymous' })).overlay(), {});
  assert.equal(f.runtime.creator('host', 'legacy'), null);
  f.runtime.scope(context('alice'), 'host', { threadId: 'legacy' });
  assert.equal(f.runtime.creator('host', 'legacy'), null);
});

test('pre-dispatch rejection preserves routing without echoing private errors; delivery failures remain unknown', async t => {
  const f = await fixture(t), replies: any[] = [];
  let sent = 0;
  const deliveryError = new Error('fixture native delivery outcome is unknown');
  const inner = { status: { state: 'open' as const }, async connect() {}, async close() {},
    subscribeStatus() { return () => {}; }, subscribeMessage() { return () => {}; },
    async send() { sent++; throw deliveryError; }, async sendWithContext() { sent++; throw deliveryError; } };
  const transport = new ExecutionEnvironmentTransport(inner, f.runtime, 'host');
  t.after(() => transport.close());
  transport.subscribeMessage(frame => replies.push(JSON.parse(frame)));
  const expired = { ...context('alice'), resourceOwner: { id: 'alice', assertCurrent() { throw new Error('synthetic-private-error'); } } };
  await transport.sendWithContext(JSON.stringify({ jsonrpc: '2.0', id: 17, __opencraftClient: 'trusted-logical-client', method: 'turn/start',
    params: { threadId: 'task', secret: 'synthetic-private-payload' }, result: 'forged-result', extra: 'private-top-level' }), expired);
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 17, __opencraftClient: 'trusted-logical-client', error: {
    code: -32602, message: 'This message was not sent. Check your access and try again.',
    data: { notSubmitted: true, submissionOutcome: 'rejected', retryable: false } } }]);
  assert.equal(sent, 0);
  await transport.sendWithContext(JSON.stringify({ method: 'turn/start', params: { threadId: 'task' } }), expired);
  assert.equal(replies.length, 1, 'rejected notification has no JSON-RPC response');
  await assert.rejects(transport.sendWithContext(JSON.stringify({ id: 18, method: 'turn/start', params: { threadId: 'legacy' } }), context('alice')), error => error === deliveryError);
  assert.equal(sent, 1);
  assert.equal(replies.length, 1, 'an unknown native outcome never becomes a safe-to-replay rejection');
});


test('shared scope compatibility matrix preserves sender, anonymous fence and immutable creation evidence', async t => {
  const f = await fixture(t), peer = new ExecutionEnvironmentRuntime(f.directory, f.vault);
  t.after(() => peer.close());
  const cases = [
    { creator: 'alice', sender: 'alice', allowed: true },
    { creator: 'alice', sender: 'bob', allowed: true },
    { creator: 'alice', sender: null, allowed: false },
    { creator: null, sender: 'alice', allowed: true },
    { creator: null, sender: 'bob', allowed: true },
    { creator: null, sender: null, allowed: true },
    { creator: undefined, sender: 'alice', allowed: true },
    { creator: undefined, sender: 'bob', allowed: true },
    { creator: undefined, sender: null, allowed: true },
  ];
  for (const [index, row] of cases.entries()) {
    const threadId = 'matrix-' + index;
    if (row.creator !== undefined) f.runtime.bindCreator(f.runtime.scope(row.creator ? context(row.creator) : { sender: null }, 'host', {}), threadId);
    const before = f.runtime.creator('host', threadId);
    const read = () => f.runtime.scope(row.sender ? context(row.sender) : { sender: null }, 'host', { threadId });
    if (!row.allowed) { assert.throws(read, { status: 403 }); continue; }
    const scope = read();
    assert.equal(scope.account, row.sender ? 'employee:' + row.sender : null);
    const token = f.runtime.seal(scope, 'turn/start');
    const opened = peer.open(token, 'host', 'turn/start', { threadId });
    assert.equal(opened.account, scope.account);
    assert.deepEqual(peer.snapshot(opened).overlay(), row.sender ? { SERVICE_KEY: 'synthetic-' + row.sender } : {});
    assert.deepEqual(f.runtime.creator('host', threadId), before);
    assert.throws(() => peer.open(token, 'host', 'turn/start', { threadId }), { status: 403 });
  }
  assert.throws(() => f.runtime.scope({ ...context('bob'), validUntil: Date.now() - 1 }, 'host', { threadId: 'matrix-1' }), { status: 401 });
});
