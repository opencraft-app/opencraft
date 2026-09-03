// skills/feai-native/scripts/__tests__/archive.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../engine.mjs', import.meta.url));
const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feai-arc-'));
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
const toArchivePhase = (dir) => {
  run(dir, 'new', '--name', 'c1');
  fs.writeFileSync(path.join(dir, '.workflow/native/changes/c1/brief.md'), '# 需求');
  run(dir, 'next', '--summary', 's', '--confirmed');
  run(dir, 'next', '--summary', 'built');
  run(dir, 'next', '--summary', 'v', '--outcome', 'pass', '--report', 'r');
};

test('verify pass → archive 阶段 await-final-action；archive 后 done 且指针清除', () => {
  const dir = tmpProject();
  toArchivePhase(dir);
  const s = run(dir, 'status');
  assert.deepEqual([s.payload.phase, s.payload.continuation.reason], ['archive', 'await-final-action']);
  const a = run(dir, 'archive');
  assert.equal(a.payload.continuation.disposition, 'done');
  assert.ok(fs.existsSync(path.join(dir, '.workflow/native/archive/c1/state.yaml')));
  assert.ok(!fs.existsSync(path.join(dir, '.workflow/native/current.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.workflow/native/changes/c1')));
});

test('非 archive 阶段执行 archive → 65', () => {
  const dir = tmpProject();
  run(dir, 'new', '--name', 'c1');
  assert.equal(run(dir, 'archive').code, 65);
});

test('archive 后 status 回到 no-active-change', () => {
  const dir = tmpProject();
  toArchivePhase(dir);
  run(dir, 'archive');
  assert.equal(run(dir, 'status').payload.continuation.reason, 'no-active-change');
});
