// skills/feai-native/scripts/__tests__/continuation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadFlow, deriveContinuation } from '../engine.mjs';

const flow = loadFlow(path.resolve(import.meta.dirname, '../../flow.yaml'));
const mkState = (step, status = 'in_progress') => ({
  current_step: step,
  steps: Object.fromEntries(flow.steps.map((s) => [s.id, { status: s.id === step ? status : 'pending' }])),
});

test('到达终点 done', () => {
  const c = deriveContinuation({ flow, state: mkState('archive', 'done'), change: 'x' });
  assert.equal(c.disposition, 'done');
});

test('终步待触发 → await-user（归档需用户明确要求）', () => {
  const c = deriveContinuation({ flow, state: mkState('archive'), change: 'x' });
  assert.deepEqual([c.disposition, c.reason], ['await-user', 'await-final-action']);
  assert.match(c.suggested_command, /archive/);
});

test('guard 缺口 → await-user 带 findings 与建议命令', () => {
  const findings = [{ guard: 'require_approval', basis: 'contract', kind: 'approval', detail: 'd' }];
  const c = deriveContinuation({ flow, state: mkState('shape'), change: 'x', findings });
  assert.deepEqual([c.disposition, c.reason], ['await-user', 'approval-required']);
  assert.match(c.suggested_command, /--confirmed/);
});

test('repair 停止 → blocked', () => {
  const c = deriveContinuation({ flow, state: mkState('verify'), change: 'x', repair: { verdict: 'stop' } });
  assert.deepEqual([c.disposition, c.reason], ['blocked', 'repair-stopped']);
});

test('正常推进 → continue 带下一步建议', () => {
  const c = deriveContinuation({ flow, state: mkState('build'), change: 'x' });
  assert.equal(c.disposition, 'continue');
  assert.match(c.suggested_command, /next/);
});

test('repair 警告不阻塞，附 finding', () => {
  const c = deriveContinuation({ flow, state: mkState('build'), change: 'x', repair: { verdict: 'warn' } });
  assert.equal(c.disposition, 'continue');
  assert.equal(c.findings[0].kind, 'repair-warn');
});
