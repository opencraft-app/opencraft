// skills/feai-native/scripts/__tests__/e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../engine.mjs', import.meta.url));
const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feai-e2e-'));
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

test('完整生命周期：new → shape(批准) → build → verify(fail 打回) → verify(pass) → archive', () => {
  const dir = tmpProject();
  assert.equal(run(dir, 'status').payload.continuation.reason, 'no-active-change');
  run(dir, 'new', '--name', 'domain-import');
  fs.writeFileSync(path.join(dir, '.workflow/native/changes/domain-import/brief.md'), '# 域名批量导入');
  assert.equal(run(dir, 'next', '--summary', '方案就绪').payload.continuation.reason, 'approval-required');
  assert.equal(run(dir, 'next', '--summary', '方案就绪', '--confirmed').payload.phase, 'build');
  assert.equal(run(dir, 'next', '--summary', '实现完成').payload.phase, 'verify');
  const f = run(dir, 'next', '--summary', '验证失败', '--outcome', 'fail', '--signature', 'e2e-timeout');
  assert.equal(f.payload.phase, 'build');
  run(dir, 'next', '--summary', '修复后重建');
  const p = run(dir, 'next', '--summary', '验证通过', '--outcome', 'pass', '--report', 'r');
  assert.equal(p.payload.phase, 'archive');
  assert.equal(run(dir, 'archive').payload.continuation.disposition, 'done');
  assert.equal(run(dir, 'status').payload.continuation.reason, 'no-active-change');
  // 审计日志记录了完整轨迹
  const audit = fs.readFileSync(path.join(dir, '.workflow/native/archive/domain-import/audit.log'), 'utf8');
  assert.ok(audit.includes('"type":"transition"') && audit.includes('"type":"archive"'));
});

test('中断恢复：锁残留（死持有者）后 next 可继续', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  const changeDir = path.join(dir, '.workflow/native/changes/c1');
  fs.writeFileSync(path.join(changeDir, '.lock'), JSON.stringify({
    token: 'dead', pid: 99999999, hostname: os.hostname(),
    startedAt: new Date(Date.now() - 3600_000).toISOString(), command: 'crashed',
  }));
  fs.writeFileSync(path.join(changeDir, 'brief.md'), '# 需求');
  const r = run(dir, 'next', '--summary', 's', '--confirmed');
  assert.equal(r.code, 0);
  assert.equal(r.payload.phase, 'build');
});

test('并发冲突：活体锁 → 73', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  const changeDir = path.join(dir, '.workflow/native/changes/c1');
  fs.writeFileSync(path.join(changeDir, '.lock'), JSON.stringify({
    token: 'alive', pid: process.pid, hostname: os.hostname(),
    startedAt: new Date().toISOString(), command: 'other-session',
  }));
  assert.equal(run(dir, 'next', '--summary', 's').code, 73);
});

test('expect-revision 不匹配 → 73', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  fs.writeFileSync(path.join(dir, '.workflow/native/changes/c1/brief.md'), '# 需求');
  assert.equal(run(dir, 'next', '--summary', 's', '--confirmed', '--expect-revision', '99').code, 73);
});
