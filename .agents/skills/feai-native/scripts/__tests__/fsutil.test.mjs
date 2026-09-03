// skills/feai-native/scripts/__tests__/fsutil.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, acquireLock, LockConflictError } from '../engine.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feai-fs-'));

test('原子写：内容完整且不留临时文件', async () => {
  const dir = tmpdir();
  const p = path.join(dir, 'a.yaml');
  await atomicWriteFile(p, 'hello: 1');
  assert.equal(fs.readFileSync(p, 'utf8'), 'hello: 1');
  assert.deepEqual(fs.readdirSync(dir), ['a.yaml']);
});

test('锁：互斥与释放', async () => {
  const dir = tmpdir();
  const l1 = await acquireLock(dir, 'cmd-a');
  await assert.rejects(() => acquireLock(dir, 'cmd-b'), (e) => e instanceof LockConflictError && e.owner.command === 'cmd-a');
  await l1.release();
  const l2 = await acquireLock(dir, 'cmd-b');
  await l2.release();
});

test('锁：死掉的持有者被回收', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({
    token: 'x', pid: 99999999, hostname: os.hostname(),
    startedAt: new Date(Date.now() - 3600_000).toISOString(), command: 'old',
  }));
  const l = await acquireLock(dir, 'cmd-new');
  await l.release();
});

test('锁：活体持有者且锁很新时不抢', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({
    token: 'x', pid: process.pid, hostname: os.hostname(),
    startedAt: new Date().toISOString(), command: 'alive',
  }));
  await assert.rejects(() => acquireLock(dir, 'cmd-b'), LockConflictError);
});

test('锁：0 字节损坏锁超龄后回收', async () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, '');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(lockPath, old, old);
  const l = await acquireLock(dir, 'cmd-new');
  await l.release();
});

test('锁：0 字节损坏锁很新时不抢', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.lock'), '');
  await assert.rejects(() => acquireLock(dir, 'cmd-b'), LockConflictError);
});
