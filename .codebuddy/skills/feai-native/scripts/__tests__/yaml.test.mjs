// skills/feai-native/scripts/__tests__/yaml.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, dumpYaml } from '../engine.mjs';

test('parse 标量', () => {
  assert.equal(parseYaml('a: 1').a, 1);
  assert.equal(parseYaml('a: true').a, true);
  assert.equal(parseYaml('a: null').a, null);
  assert.equal(parseYaml('a: hello').a, 'hello');
  assert.equal(parseYaml('a: "含: 冒号"').a, '含: 冒号');
});

test('parse 嵌套 map 与缩进', () => {
  const v = parseYaml('a:\n  b: 1\n  c:\n    d: x');
  assert.deepEqual(v, { a: { b: 1, c: { d: 'x' } } });
});

test('parse 标量列表与 map 列表', () => {
  const v = parseYaml('outcomes:\n  - pass\n  - fail\nsteps:\n  - id: shape\n    next: build\n  - id: verify\n    on:\n      pass: archive');
  assert.deepEqual(v.outcomes, ['pass', 'fail']);
  assert.deepEqual(v.steps[0], { id: 'shape', next: 'build' });
  assert.deepEqual(v.steps[1].on, { pass: 'archive' });
});

test('parse 行内列表与注释', () => {
  const v = parseYaml('# 头注释\noutcomes: [pass, fail]  # 尾注释\noverrides: []');
  assert.deepEqual(v.outcomes, ['pass', 'fail']);
  assert.deepEqual(v.overrides, []);
});

test('parse 非法输入抛错', () => {
  assert.throws(() => parseYaml('a:\n   b: 1\n  c: 2'), /YAML/);
});

test('引号内的 # 不被当作注释', () => {
  assert.equal(parseYaml('a: "hello # world"').a, 'hello # world');
  assert.equal(parseYaml('a: "含: 冒号 # 井号"').a, '含: 冒号 # 井号');
  assert.equal(parseYaml('a: value # 真注释').a, 'value');
});

test('Tab 缩进抛错', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), /Tab/);
});

test('__proto__ 键作为普通 own property', () => {
  const v = parseYaml('__proto__: 1');
  assert.equal(Object.prototype.hasOwnProperty.call(v, '__proto__'), true);
  assert.equal(v['__proto__'], 1);
});

test('dump 需要引号的字符串', () => {
  assert.equal(dumpYaml('plain'), 'plain');
  assert.equal(dumpYaml('含: 冒号'), '"含: 冒号"');
  assert.equal(dumpYaml('true'), '"true"');
  assert.equal(dumpYaml('123'), '"123"');
});

test('round-trip 复合结构', () => {
  const v = {
    schema: 'feai.native.v1', revision: 4, current_step: 'build',
    steps: { shape: { status: 'done' }, build: { status: 'in_progress', attempts: 1 } },
    failure: { last_signature: 'verify:test-timeout', consecutive_same: 1, total: 3, overrides_used: [] },
    last_transition: { fingerprint: 'sha256:ab', from: 'shape', to: 'build', at: '2026-08-05T10:00:00Z' },
    data: { contract_hash: null, approved_contract_hash: 'sha256:cd' },
  };
  assert.deepEqual(parseYaml(dumpYaml(v)), v);
});

test('round-trip flow 结构', () => {
  const v = {
    name: 'feai-native', version: '0.1.0',
    steps: [
      { id: 'shape', next: 'build', guards: [{ require_approval: 'contract' }] },
      { id: 'verify', outcomes: ['pass', 'fail'], on: { pass: 'archive', fail: { to: 'build', guard: 'repeated-failure' } } },
      { id: 'archive', outcomes: ['done'], on: { done: null } },
    ],
  };
  assert.deepEqual(parseYaml(dumpYaml(v)), v);
});

test('空对象与空数组 round-trip', () => {
  const v = { a: {}, b: [], c: [{}], d: [[]], e: { f: {} } };
  assert.deepEqual(parseYaml(dumpYaml(v)), v);
});

test('state 初始形态 round-trip（data 为空对象）', () => {
  const v = { schema: 'feai.native.v1', revision: 1, data: {} };
  assert.deepEqual(parseYaml(dumpYaml(v)), v);
});

test('含 # 与换行的字符串 round-trip', () => {
  assert.equal(parseYaml(dumpYaml({ s: 'a # 1' })).s, 'a # 1');
  assert.equal(parseYaml(dumpYaml({ s: '行1\n行2' })).s, '行1\n行2');
});
