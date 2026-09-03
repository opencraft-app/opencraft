// skills/feai-native/scripts/__tests__/flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFlow } from '../engine.mjs';

function tmpFlow(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feai-flow-'));
  const p = path.join(dir, 'flow.yaml');
  fs.writeFileSync(p, text);
  return p;
}

test('加载合法 flow 并索引 steps', () => {
  const flow = loadFlow(tmpFlow('name: t\nversion: 0.0.1\nsteps:\n  - id: a\n    next: b\n  - id: b\n    outcomes: [done]\n    on:\n      done: null\n'));
  assert.equal(flow.name, 't');
  assert.equal(flow.firstStep, 'a');
  assert.equal(flow.stepMap.get('b').outcomes.length, 1);
  assert.deepEqual(flow.limits, { warnAt: 2, stopAt: 3, hardStopAtTotal: 12, allowOverridePerSignature: true });
});

test('step 引用不存在的目标报错', () => {
  assert.throws(() => loadFlow(tmpFlow('name: t\nversion: 0.0.1\nsteps:\n  - id: a\n    next: nowhere\n')), /nowhere/);
});

test('outcomes 必须被 on 覆盖', () => {
  assert.throws(() => loadFlow(tmpFlow('name: t\nversion: 0.0.1\nsteps:\n  - id: a\n    outcomes: [pass, fail]\n    on:\n      pass: a\n')), /fail/);
});

test('未知 guard 名报错', () => {
  assert.throws(() => loadFlow(tmpFlow('name: t\nversion: 0.0.1\nsteps:\n  - id: a\n    next: a\n    guards:\n      - require_nope: x\n')), /require_nope/);
});
