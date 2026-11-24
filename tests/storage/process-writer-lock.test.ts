import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireOwnerLock, acquireProcessWriter } from '../../packages/sqlite-node/src/index.ts';
import { acquireOwnerLockOffThread, lockFileExclusive } from '../../packages/sqlite-node/src/locks.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'oc-writer-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'writer.lock');
}
test('legacy ownership without a process identity is never reclaimed by age', async t => {
  const path = await fixture(t); await mkdir(path);
  await utimes(path, 0, 0);
  assert.throws(() => acquireProcessWriter(path), { code: 'ELOCKED' });
  assert.equal((await stat(path)).isDirectory(), true);
});
test('owner identity is checked and a reused PID is distinguished by start time', { skip: process.platform !== 'linux' }, async t => {
  const path = await fixture(t), release = acquireProcessWriter(path);
  release();
  const previous = JSON.parse(await readFile(path + '.owner.json', 'utf8'));
  await writeFile(path + '.owner.json', JSON.stringify({ ...previous, released: false }));
  assert.throws(() => acquireProcessWriter(path), { code: 'ELOCKED' });
  await writeFile(path + '.owner.json', JSON.stringify({ ...previous, start: '0', released: false }));
  acquireProcessWriter(path)();
  assert.equal((await stat(path)).isFile(), true);
});
test('a SIGSTOPed writer never expires and SIGKILL releases the kernel lock without deleting it', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const path = await fixture(t);
  const child = fork(new URL('../fixtures/process-writer.mjs', import.meta.url), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  await once(child, 'message');
  const inode = (await stat(path)).ino;
  child.kill('SIGSTOP'); await utimes(path, 0, 0);
  assert.throws(() => acquireProcessWriter(path), { code: 'ELOCKED' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  acquireProcessWriter(path)();
  assert.equal((await stat(path)).ino, inode);
});

test('an owner lock held off the event loop excludes in-thread owners until released and converts only expired legacy leases', async t => {
  const path = await fixture(t), legacy = join(dirname(path), 'legacy.lock');
  const release = await acquireOwnerLockOffThread(path);
  assert.throws(() => acquireProcessWriter(path), { code: 'ELOCKED' });
  await assert.rejects(acquireOwnerLockOffThread(path), { code: 'ELOCKED' });
  await release();
  (await acquireOwnerLock(path))();
  await mkdir(legacy);
  await assert.rejects(acquireOwnerLockOffThread(legacy), { code: 'ELOCKED' });
  const expired = new Date(Date.now() - 120_000);
  await utimes(legacy, expired, expired);
  await (await acquireOwnerLockOffThread(legacy))();
  assert.equal((await stat(legacy)).isFile(), true);
});

test('a short exclusive lock held off the event loop refuses a second holder with ELOCKED', async t => {
  const path = join(dirname(await fixture(t)), 'document.json.lock');
  const release = await lockFileExclusive(path);
  await assert.rejects(lockFileExclusive(path, { retries: 2 }), { code: 'ELOCKED', message: 'Lock file is already being held' });
  await release();
  await (await lockFileExclusive(path))();
});
