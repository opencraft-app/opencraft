import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
const moduleUrl = new URL('../../scripts/web-deployment/lock.mjs', import.meta.url).href;
test('concurrent processes cannot both take over a crashed deployment owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-lock-test-'));
  const processes = [];
  const start = () => {
    const code = `import { acquireDeploymentLock } from ${JSON.stringify(moduleUrl)};\ntry { const release = await acquireDeploymentLock(${JSON.stringify(directory)}); console.log('owner'); process.stdin.resume(); process.stdin.once('data',async()=>{await release();process.exit(0)}); } catch { console.log('busy'); process.exit(0); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] }); processes.push(child);
    return new Promise(resolve => child.stdout.once('data', data => resolve({ child, result: data.toString().trim() })));
  };
  try {
    await mkdir(join(directory, 'deployment-lock'));
    await writeFile(join(directory, 'deployment-lock', `2147483647-${randomUUID()}`), '');
    const first = await Promise.all(Array.from({ length: 8 }, start));
    assert.ok(first.filter(result => result.result === 'owner').length <= 1);
    let owner = first.find(result => result.result === 'owner');
    if (!owner) owner = await start();
    assert.equal(owner.result, 'owner');
    assert.equal((await start()).result, 'busy');
    const ended = once(owner.child, 'exit'); owner.child.stdin.write('release'); await ended;
    const replacement = await start(); assert.equal(replacement.result, 'owner');
    const done = once(replacement.child, 'exit'); replacement.child.stdin.write('release'); await done;
  } finally { for (const child of processes) child.kill(); await rm(directory, { recursive: true, force: true }); }
});
