import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isThreadGoalPauseRequest } from '@opencraft/appserver-protocol';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { CodexEngineAdapter } from '../../apps/opencraft-daemon/src/codex-engine-adapter.js';
import { isCodexAdmission } from '../../apps/opencraft-daemon/src/codex-maintenance.js';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store.js';
import { ExecutionEnvironmentRuntime, executionEnvironmentOwner, requiresEnvironmentAuthority, requiresCurrentEnvironmentAuthority } from '../../scripts/execution-environment.js';

const pause = { threadId: 'goal-task', status: 'paused' };
const context = (subject = 'alice'): TransportSubmissionContext => ({ sender: { kind: 'employee', loginName: subject },
  executionPrincipal: { provider: 'fixture', subject }, validUntil: Date.now() + 60_000 });

test('only a pure pause bypasses maintenance admission; all Goal intent retains identity/Thread admission', () => {
  for (const value of [pause, { ...pause, expectedVersion: '0' }, { ...pause, expectedVersion: '9223372036854775807' }]) {
    assert.equal(isThreadGoalPauseRequest('thread/goal/set', value), true);
    assert.equal(requiresEnvironmentAuthority('thread/goal/set'), true);
    assert.equal(requiresCurrentEnvironmentAuthority('thread/goal/set', value), false);
    assert.equal(isCodexAdmission('thread/goal/set', value), false);
  }
  for (const extra of [{ objective: 'new work' }, { objective: null }, { tokenBudget: null }, { status: 'active' },
    { status: 'blocked' }, { expectedVersion: null }, { expectedVersion: 7 }, { expectedVersion: '01' },
    { expectedVersion: '-1' }, { expectedVersion: '9223372036854775808' }, { expectedVersion: '9'.repeat(100) },
    { threadId: '' }, { threadId: 'x'.repeat(513) }, { __opencraftEnvironment: 'forged' }, { surprise: true }]) {
    const value = { ...pause, ...extra };
    assert.equal(isThreadGoalPauseRequest('thread/goal/set', value), false, JSON.stringify(extra));
    assert.equal(requiresCurrentEnvironmentAuthority('thread/goal/set', value), false);
    assert.equal(isCodexAdmission('thread/goal/set', value), true);
  }
  assert.equal(isThreadGoalPauseRequest('thread/goal/clear', pause), false);
  for (const value of [null, [], undefined, 'paused']) assert.equal(isThreadGoalPauseRequest('thread/goal/set', value), false);
});

class NativeFixture implements DuplexTransport {
  status: TransportStatus = { state: 'idle' };
  sent: any[] = [];
  listeners = new Set<(frame: string) => void>();
  goal: any = { threadId: pause.threadId, objective: 'original goal', status: 'active', tokenBudget: null, tokensUsed: 15, timeUsedSeconds: 9, createdAt: 1, updatedAt: 2 };
  holdPause = false;
  rejectPause = false;
  writable = true;
  async connect() { this.status = { state: 'open' }; }
  subscribeStatus() { return () => {}; }
  subscribeMessage(fn: (frame: string) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(frame: unknown) { for (const fn of this.listeners) fn(JSON.stringify(frame)); }
  async send(raw: string) {
    const value = JSON.parse(raw); this.sent.push(value);
    if (value.id === undefined) return;
    let result: any = {};
    if (value.method === 'initialize') result = { capabilities: { extensions: { 'opencraft/thread-goal': { version: 1, read: true, write: this.writable } } } };
    if (value.method === 'experimentalFeature/list') result = { data: [{ name: 'goals', enabled: true }] };
    if (value.method === 'thread/read') result = { thread: { id: pause.threadId, status: { type: 'active' }, turns: [], name: 'fixture' } };
    if (value.method === 'thread/goal/get') result = { goal: this.goal };
    if (value.method === 'thread/goal/set') {
      if (this.holdPause) return;
      if (this.rejectPause) { queueMicrotask(() => this.emit({ id: value.id, error: { code: -32009, message: 'Goal version changed', data: { reason: 'goal_version_conflict' } } })); return; }
      this.goal = { ...this.goal, status: value.params.status }; result = { goal: this.goal };
    }
    queueMicrotask(() => this.emit({ id: value.id, result }));
  }
  async close() { this.status = { state: 'closed' }; }
}

async function fixture(t: test.TestContext, writable = true) {
  const root = await mkdtemp(join(tmpdir(), 'goal-pause-admission-'));
  const vault = new EmployeeGitVaultStore(root), runtime = new ExecutionEnvironmentRuntime(root, vault);
  runtime.bindCreator(runtime.scope(context(), 'local-codex', {}), pause.threadId);
  const physical = new NativeFixture(), frames: any[] = [], diagnostics: any[] = [];
  physical.writable = writable;
  const adapter = new CodexEngineAdapter({ kind: 'remote', transport: physical, executionEnvironment: runtime, logDiagnostic: e => diagnostics.push(e) });
  adapter.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  let sequence = 0;
  const send = async (method: string, params: any = {}, caller: TransportSubmissionContext = context(), client = 'reader') => {
    const id = ++sequence;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }), caller);
    for (let n = 0; n < 400; n++) { const reply = frames.find(v => v.id === id && v[LOGICAL_CLIENT_FIELD] === client); if (reply) return reply; await new Promise(r => setTimeout(r, 5)); }
    throw Error('Fixture timed out: ' + method);
  };
  await adapter.connect(); await send('initialize');
  t.after(async () => { await adapter.close(); runtime.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
  return { adapter, physical, frames, diagnostics, runtime, send };
}

for (const reconnect of [false, true]) test(`pure pause after read-only opening needs no applied execution environment (reconnect=${reconnect})`, async t => {
  const f = await fixture(t);
  await f.send('thread/read', { threadId: pause.threadId, includeTurns: false, watch: true });
  await f.send('thread/goal/get', { threadId: pause.threadId });
  if (reconnect) {
    await f.adapter.send(JSON.stringify({ method: 'runtime/client/disconnect', [LOGICAL_CLIENT_FIELD]: 'reader' }));
    await f.send('initialize');
    await f.send('thread/read', { threadId: pause.threadId, includeTurns: false, watch: true });
  }
  assert.equal((f.adapter as any).executionEnvironments.size, 0);
  const payload = { ...pause, expectedVersion: '7' };
  const reply = await f.send('thread/goal/set', payload);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.goal.status, 'paused');
  assert.equal(reply.result.goal.tokensUsed, 15);
  assert.equal(reply.result.goal.timeUsedSeconds, 9);
  assert.deepEqual(f.physical.sent.filter(x => x.method === 'thread/goal/set').map(x => x.params), [payload]);
  assert.equal(f.physical.sent.some(x => ['thread/resume', 'turn/start', 'turn/interrupt', 'thread/settings/update'].includes(x.method)), false);
  assert.equal((f.adapter as any).executionEnvironments.size, 0);
  assert.ok(f.diagnostics.some(e => e.event === 'goal-pause-native-reply' && e.status === 'paused'));
});

test('pause still rejects expired/revoked identity; mixed edits retain execution maintenance admission', async t => {
  const f = await fixture(t);
  for (const caller of [{ ...context(), validUntil: 1 }, { ...context(), resourceOwner: { id: 'revoked', assertCurrent() { throw Error('revoked'); } } }]) {
    const reply = await f.send('thread/goal/set', pause, caller);
    assert.ok(reply.error);
  }
  for (const params of [{ ...pause, objective: 'different task' }, { ...pause, tokenBudget: 100 }, { ...pause, status: 'active' }]) {
    assert.equal(isCodexAdmission('thread/goal/set',params),true);
  }
  assert.equal(f.physical.sent.some(x => x.method === 'thread/goal/set'), false);
  assert.equal(f.physical.goal.status, 'active');
});

test('native version conflict remains a rejection, not a retry or local success', async t => {
  const f = await fixture(t); f.physical.rejectPause = true;
  const reply = await f.send('thread/goal/set', { ...pause, expectedVersion: '6' });
  assert.equal(reply.error.code, -32009);
  assert.equal(f.physical.goal.status, 'active');
  assert.equal(f.physical.sent.filter(x => x.method === 'thread/goal/set').length, 1);
  assert.ok(f.diagnostics.some(e => e.event === 'goal-pause-native-reply' && e.outcome === 'rpc-error'));
});

test('read-only Goal capability cannot use the pause exception', async t => {
  const f = await fixture(t, false);
  const reply = await f.send('thread/goal/set', pause);
  assert.equal(reply.error.code, -32601);
  assert.equal(f.physical.sent.some(x => x.method === 'thread/goal/set'), false);
});

test('Goal edits with installed configuration preserve the native intent path', async t => {
  const f = await fixture(t);
  const scope = f.runtime.scope(context(), 'local-codex', { threadId: pause.threadId });
  (f.adapter as any).executionEnvironments.set(pause.threadId, { owner: executionEnvironmentOwner(scope), account: scope.account });
  const payload = { ...pause, status: 'active', objective: 'explicit continued work' };
  const reply = await f.send('thread/goal/set', payload);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.deepEqual(f.physical.sent.filter(x => x.method === 'thread/goal/set').map(x => x.params), [payload]);
});
