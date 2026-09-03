// skills/feai-native/scripts/__tests__/machine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFlow, resolveNext, edgeGuard, checkStepGuards, UsageError } from '../engine.mjs';

const FLOW = path.resolve(import.meta.dirname, '../../flow.yaml');
const flow = loadFlow(FLOW);
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feai-machine-'));

test('无分支 step 走静态 next', () => {
  assert.equal(resolveNext(flow, 'build', undefined), 'verify');
});

test('分支 step 需要 outcome 且按 on 解析', () => {
  assert.equal(resolveNext(flow, 'verify', 'pass'), 'archive');
  assert.equal(resolveNext(flow, 'verify', 'fail'), 'build');
  assert.throws(() => resolveNext(flow, 'verify', undefined), UsageError);
  assert.throws(() => resolveNext(flow, 'verify', 'maybe'), UsageError);
});

test('终点返回 null；带 guard 的边被识别', () => {
  assert.equal(resolveNext(flow, 'archive', 'done'), null);
  assert.equal(edgeGuard(flow, 'verify', 'fail'), 'repeated-failure');
  assert.equal(edgeGuard(flow, 'verify', 'pass'), null);
});

test('require_field：缺失与非空', () => {
  const stepDef = { id: 't', guards: [{ require_field: 'summary' }] };
  const miss = checkStepGuards({ flow, stepDef, submission: {}, changeDir: tmpdir(), state: { data: {} } });
  assert.equal(miss[0].guard, 'require_field');
  const ok = checkStepGuards({ flow, stepDef, submission: { summary: 'x' }, changeDir: tmpdir(), state: { data: {} } });
  assert.deepEqual(ok, []);
});

test('require_approval：hash 匹配/不匹配/confirmed 批准', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'brief.md'), '# 需求 v1');
  const stepDef = flow.stepMap.get('shape');
  const state = { data: {} };
  const first = checkStepGuards({ flow, stepDef, submission: {}, changeDir: dir, state });
  assert.equal(first[0].guard, 'require_approval');
  const approved = checkStepGuards({ flow, stepDef, submission: { confirmed: true }, changeDir: dir, state });
  assert.deepEqual(approved, []);
  assert.ok(state.data.approved_contract_hash);
  const again = checkStepGuards({ flow, stepDef, submission: {}, changeDir: dir, state });
  assert.deepEqual(again, []);
  fs.writeFileSync(path.join(dir, 'brief.md'), '# 需求 v2 被改动');
  const drift = checkStepGuards({ flow, stepDef, submission: {}, changeDir: dir, state });
  assert.equal(drift[0].guard, 'require_approval');
});
