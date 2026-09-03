// skills/feai-native/scripts/__tests__/state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFlow, initState, readState, writeState, StateError } from '../engine.mjs';

const FLOW = path.resolve(import.meta.dirname, '../../flow.yaml');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feai-state-'));

test('initState 按 flow 初始化两层状态', () => {
  const flow = loadFlow(FLOW);
  const s = initState(flow, '2026-08-06T00:00:00Z');
  assert.equal(s.schema, 'feai.native.v1');
  assert.equal(s.revision, 1);
  assert.equal(s.current_step, 'shape');
  assert.equal(s.steps.shape.status, 'in_progress');
  assert.equal(s.steps.build.status, 'pending');
  assert.deepEqual(s.failure.overrides_used, []);
  assert.equal(s.last_transition, null);
  assert.deepEqual(s.data, {});
});

test('write/read 往返且 revision 递增', async () => {
  const flow = loadFlow(FLOW);
  const dir = tmpdir();
  const s = initState(flow, '2026-08-06T00:00:00Z');
  await writeState(dir, s, { expectRevision: 0 });
  const r = await readState(dir);
  assert.equal(r.revision, 1);
  assert.equal(r.current_step, 'shape');
  const r2 = await writeState(dir, r, { expectRevision: 1 });
  assert.equal(r2.revision, 2);
});

test('CAS：expectRevision 不匹配拒绝', async () => {
  const flow = loadFlow(FLOW);
  const dir = tmpdir();
  await writeState(dir, initState(flow, '2026-08-06T00:00:00Z'), {});
  const s = await readState(dir);
  await assert.rejects(() => writeState(dir, s, { expectRevision: 99 }),
    (e) => e instanceof StateError && /revision/u.test(e.message));
});

test('readState 校验 schema 与必需字段', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'state.yaml'), 'schema: wrong.v9\nrevision: 1\n');
  await assert.rejects(() => readState(dir), StateError);
});
