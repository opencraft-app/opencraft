// skills/feai-native/scripts/__tests__/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../engine.mjs', import.meta.url));
const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feai-proj-'));
  fs.mkdirSync(path.join(dir, '.workflow/native/changes'), { recursive: true });
  return dir;
};
const run = (cwd, ...args) => {
  try {
    const out = execFileSync('node', [ENGINE, ...args, '--json'], { cwd, encoding: 'utf8' });
    return { code: 0, payload: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, payload: JSON.parse(e.stdout || '{}') };
  }
};

test('new 创建 change 与指针；重复创建被拒', () => {
  const dir = tmpProject();
  const r1 = run(dir, 'new', '--name', 'add-login');
  assert.equal(r1.code, 0);
  assert.equal(r1.payload.continuation.disposition, 'continue');
  assert.ok(fs.existsSync(path.join(dir, '.workflow/native/changes/add-login/state.yaml')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.workflow/native/current.json'), 'utf8')), { change: 'add-login' });
  const r2 = run(dir, 'new', '--name', 'other');
  assert.equal(r2.code, 65);
});

test('new 校验 kebab-case', () => {
  const dir = tmpProject();
  assert.equal(run(dir, 'new', '--name', 'Bad_Name').code, 64);
});

test('status 无 active change → await-user/no-active-change', () => {
  const dir = tmpProject();
  const r = run(dir, 'status');
  assert.equal(r.code, 0);
  assert.deepEqual([r.payload.continuation.disposition, r.payload.continuation.reason], ['await-user', 'no-active-change']);
});

test('已共享的 brief 在新工作树显式 resume 后重建本地状态', () => {
  const dir = tmpProject();
  const change = path.join(dir, '.workflow/native/changes/add-login');
  fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(change, 'brief.md'), '# 登录\n\n已提交的需求契约。\n');

  const status = run(dir, 'status');
  assert.equal(status.code, 0);
  assert.equal(status.payload.continuation.reason, 'resume-selection-required');
  assert.deepEqual(status.payload.candidates, ['add-login']);
  assert.equal(run(dir, 'new', '--name', 'other').code, 65);

  const resumed = run(dir, 'resume', '--name', 'add-login');
  assert.equal(resumed.code, 0);
  assert.equal(resumed.payload.reconstructed, true);
  assert.equal(resumed.payload.phase, 'shape');
  assert.ok(fs.existsSync(path.join(change, 'state.yaml')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.workflow/native/current.json'), 'utf8')), { change: 'add-login' });
});

test('resume 复用本地状态，并拒绝不存在的共享 brief', () => {
  const dir = tmpProject();
  assert.equal(run(dir, 'resume', '--name', 'missing').code, 65);
  run(dir, 'new', '--name', 'add-login');
  fs.writeFileSync(path.join(dir, '.workflow/native/changes/add-login/brief.md'), '# 登录\n');
  const resumed = run(dir, 'resume', '--name', 'add-login');
  assert.equal(resumed.code, 0);
  assert.equal(resumed.payload.reconstructed, false);
});

test('status 指针自愈：指向已归档 change 时清除并提示', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'add-login');
  fs.renameSync(path.join(dir, '.workflow/native/changes/add-login'), path.join(dir, '.workflow/native/archive-tmp'));
  fs.mkdirSync(path.join(dir, '.workflow/native/archive'), { recursive: true });
  fs.renameSync(path.join(dir, '.workflow/native/archive-tmp'), path.join(dir, '.workflow/native/archive/add-login'));
  const r = run(dir, 'status');
  assert.equal(r.code, 0);
  assert.equal(r.payload.continuation.reason, 'no-active-change');
  assert.ok(!fs.existsSync(path.join(dir, '.workflow/native/current.json')));
});

test('status 非法指针内容（路径逃逸）→ 自愈删除并提示 no-active-change', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, '.workflow/native/current.json'), JSON.stringify({ change: '../evil' }));
  const r = run(dir, 'status');
  assert.equal(r.code, 0);
  assert.equal(r.payload.continuation.reason, 'no-active-change');
  assert.ok(!fs.existsSync(path.join(dir, '.workflow/native/current.json')));
});
