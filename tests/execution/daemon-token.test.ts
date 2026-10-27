import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { OpenCraftDaemonClientManager } from '../../apps/workbench-electron/src/daemon-client.ts';

test('server manager preserves shared token identity, permissions and ACL and rejects missing/invalid tokens without creating one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-token-'));
  const tokenPath = join(root, 'token');
  const options = { endpoint: join(root, 'daemon.sock'), tokenPath, tokenMode: 'existing' as const, runtimeDirectory: root,
    daemonEntry: '/unused', dshExecutable: '/unused', dataDirectory: root, codexExecutable: '/unused', codexDataDirectory: root,
    nativeCodexHomeDirectory: root, executable: process.execPath };
  try {
    assert.throws(() => new OpenCraftDaemonClientManager(options), /ENOENT/);
    await assert.rejects(readFile(tokenPath), { code: 'ENOENT' });
    await writeFile(tokenPath, 'short', { mode: 0o640 });
    assert.throws(() => new OpenCraftDaemonClientManager(options), /Invalid existing/);
    assert.equal(await readFile(tokenPath, 'utf8'), 'short');
    const token = 'synthetic-' + 'x'.repeat(48); await writeFile(tokenPath, token); await chmod(tokenPath, 0o640);
    let beforeAcl: string | undefined;
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      execFileSync('setfacl', ['-m', 'u:nobody:r', tokenPath]);
      beforeAcl = execFileSync('getfacl', ['--omit-header', tokenPath], { encoding: 'utf8' });
    }
    const mode = (await stat(tokenPath)).mode;
    new OpenCraftDaemonClientManager(options);
    assert.equal(await readFile(tokenPath, 'utf8'), token); assert.equal((await stat(tokenPath)).mode, mode);
    if (beforeAcl !== undefined) assert.equal(execFileSync('getfacl', ['--omit-header', tokenPath], { encoding: 'utf8' }), beforeAcl);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shutdown during an unavailable endpoint probe never launches a replacement daemon', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-shutdown-'));
  const marker = join(root, 'spawned'); const entry = join(root, 'daemon.cjs'); const tokenPath = join(root, 'token');
  try {
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
    await writeFile(tokenPath, 'synthetic-' + 'x'.repeat(48));
    const manager = new OpenCraftDaemonClientManager({ endpoint: join(root, 'missing.sock'), tokenPath, tokenMode: 'existing',
      runtimeDirectory: root, daemonEntry: entry, dshExecutable: '/unused', dataDirectory: root, codexExecutable: '/unused',
      codexDataDirectory: root, nativeCodexHomeDirectory: root, executable: process.execPath });
    const connection = manager.connectAppHost('closing-probe');
    const stopped = manager.shutdown();
    await assert.rejects(connection, /shutting down/); await stopped;
    await new Promise(done => setTimeout(done, 200));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(manager.connectAppHost('late'), /shutting down/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
