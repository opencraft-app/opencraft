import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { managedOwnerState } from '../../scripts/remote-browser-owner.mjs';

async function queryWithOwnedChild(source, check) {
  const root = await mkdtemp(join(tmpdir(), 'browser-owner-query-')), bin = join(root, 'bin');
  await mkdir(bin); const executable = join(bin, 'systemctl');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`); await chmod(executable, 0o700);
  const original = process.env.PATH;
  try { process.env.PATH = bin + delimiter + original; await check(); }
  finally { process.env.PATH = original; await rm(root, { recursive: true, force: true }); }
}
const linuxOnly = { skip: process.platform !== 'linux' };

test('managed query reads only the current bounded incarnation fields', linuxOnly, async () => {
  await queryWithOwnedChild(`process.stdout.write('LoadState=loaded\\nActiveState=active\\nMainPID=123\\nInvocationID=${'a'.repeat(32)}\\n');`, async () => {
    assert.deepEqual(await managedOwnerState('owned-fixture-query'), { state: 'active', pid: 123, invocation: 'a'.repeat(32) });
  });
});

test('managed query deadline returns without waiting for a child that ignores SIGTERM', linuxOnly, async () => {
  await queryWithOwnedChild(`process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),7000);`, async () => {
    const start = performance.now();
    await assert.rejects(managedOwnerState('owned-fixture-query'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 6200, `query deadline took ${elapsed}ms`);
  });
});

test('managed query output overflow rejects immediately even when the child ignores SIGTERM', linuxOnly, async () => {
  await queryWithOwnedChild(`process.on('SIGTERM',()=>{});process.stdout.write('X'.repeat(8192));setTimeout(()=>process.exit(0),7000);`, async () => {
    const start = performance.now();
    await assert.rejects(managedOwnerState('owned-fixture-query'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    assert.ok(performance.now() - start < 1500, 'output overflow must not wait for the child or the query timeout');
  });
});
