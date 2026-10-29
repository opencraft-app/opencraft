import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireProcessWriter } from '../../packages/sqlite-node/src/index.ts';

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
