import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oc-headless-lifecycle-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => { if (child.exitCode !== null || child.signalCode) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    const child = fork(new URL('../fixtures/headless-lifecycle.mjs', import.meta.url), [root], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const first = await Promise.race([once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(() => { throw Error(stderr || 'fixture exited without readiness'); })]);
    return { child, first };
  }
  return { root, start };
}

test('Headless successor acquires the writer immediately after slow stop is SIGKILLed', { timeout: 20000 }, async t => {
  const f = await fixture(t), old = await f.start();
  assert.equal(old.first.event, 'ready');
  const flushing = once(old.child, 'message'); old.child.kill('SIGTERM');
  assert.equal((await flushing)[0].event, 'flushing');
  const exited = once(old.child, 'exit'); old.child.kill('SIGKILL'); await exited;
  const successor = await f.start();
  assert.equal(successor.first.event, 'ready', JSON.stringify(successor.first));
});

test('Headless retains its writer throughout slow flush and releases it before the successor opens stores', { timeout: 20000 }, async t => {
  const f = await fixture(t), old = await f.start();
  assert.equal(old.first.event, 'ready');
  const flushing = once(old.child, 'message'); old.child.kill('SIGTERM'); await flushing;
  const competitor = await f.start();
  assert.equal(competitor.first.event, 'error');
  const exited = once(old.child, 'exit'); old.child.send('flush'); await exited;
  assert.equal(await readFile(join(f.root, 'flushed'), 'utf8'), 'durable');
  const successor = await f.start(); assert.equal(successor.first.event, 'ready', JSON.stringify(successor.first));
});
