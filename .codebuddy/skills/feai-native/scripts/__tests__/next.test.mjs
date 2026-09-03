// skills/feai-native/scripts/__tests__/next.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../engine.mjs', import.meta.url));
const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feai-next-'));
  fs.mkdirSync(path.join(dir, '.workflow/native/changes'), { recursive: true });
  return dir;
};
const run = (cwd, ...args) => {
  try {
    const stdout = execFileSync('node', [ENGINE, ...args, '--json'], { cwd, encoding: 'utf8' });
    return { code: 0, payload: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status, payload: JSON.parse(e.stdout || '{}') };
  }
};
const brief = (dir, content = '# 需求') => fs.writeFileSync(
  path.join(dir, '.workflow/native/changes/c1/brief.md'), content);

test('shape 未批准 → await-user；confirmed 后进入 build', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  const r1 = run(dir, 'next', '--summary', 's');
  assert.deepEqual([r1.payload.continuation.disposition, r1.payload.continuation.reason], ['await-user', 'approval-required']);
  const r2 = run(dir, 'next', '--summary', 's', '--confirmed');
  assert.equal(r2.payload.phase, 'build');
  brief(dir, '# 需求被改');
  const r3 = run(dir, 'next', '--summary', 's');
  assert.equal(r3.payload.continuation.reason, 'approval-required'); // build 的 require_approval 检出 brief 漂移
});

test('build 缺 summary → await-user/field-missing；带 summary 正常推进', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  run(dir, 'next', '--summary', 's', '--confirmed');
  const miss = run(dir, 'next');
  assert.deepEqual([miss.code, miss.payload.continuation.reason], [0, 'field-missing']);
  const r = run(dir, 'next', '--summary', 'done');
  assert.equal(r.payload.phase, 'verify');
});

test('verify：fail 打回 build，同签名 2 警 3 停，override 放行', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  run(dir, 'next', '--summary', 's', '--confirmed');
  run(dir, 'next', '--summary', 'built');
  const f1 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  assert.equal(f1.payload.phase, 'build');
  run(dir, 'next', '--summary', 'built2');
  const f2 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  assert.deepEqual([f2.payload.phase, f2.payload.continuation.findings[0]?.kind], ['build', 'repair-warn']);
  run(dir, 'next', '--summary', 'built3');
  const f3 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  assert.deepEqual([f3.code, f3.payload.continuation.disposition], [75, 'blocked']);
  const f4 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a', '--confirmed');
  assert.equal(f4.payload.phase, 'build'); // override 放行
});

test('幂等：同一请求重放返回上次结果且 revision 不变', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  const r1 = run(dir, 'next', '--summary', 's', '--confirmed');
  const r2 = run(dir, 'next', '--summary', 's', '--confirmed');
  assert.equal(r1.payload.revision, r2.payload.revision);
  assert.deepEqual(r1.payload.phase, r2.payload.phase);
});

test('终态推进幂等：next --outcome done 重放返回上次结果', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  run(dir, 'next', '--summary', 's', '--confirmed');
  run(dir, 'next', '--summary', 'built');
  run(dir, 'next', '--summary', 'v', '--outcome', 'pass', '--report', 'r');
  const d1 = run(dir, 'next', '--summary', '归档', '--outcome', 'done');
  assert.equal(d1.payload.continuation.disposition, 'done');
  const d2 = run(dir, 'next', '--summary', '归档', '--outcome', 'done');
  assert.equal(d2.payload.replayed, true);
  assert.equal(d1.payload.revision, d2.payload.revision);
});

test('repair stop 重放：同一 fail 请求重试不侵蚀失败计数', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  brief(dir);
  run(dir, 'next', '--summary', 's', '--confirmed');
  run(dir, 'next', '--summary', 'built');
  run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  run(dir, 'next', '--summary', 'b2');
  run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  run(dir, 'next', '--summary', 'b3');
  const s1 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  assert.deepEqual([s1.code, s1.payload.continuation.disposition], [75, 'blocked']);
  const s2 = run(dir, 'next', '--summary', 'v', '--outcome', 'fail', '--signature', 't-a');
  assert.equal(s2.payload.replayed, true);
  assert.equal(s2.code, 0); // 重放返回存储的结果码路径：out() 默认 0；payload 内 ok:false
  assert.equal(s1.payload.revision, s2.payload.revision);
});
