import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertExecutionNativePayload } from '../../scripts/server-deployment/native-preflight.mjs';
import { createExecutionDeployment } from '../../scripts/server-deployment/execution.mjs';

test('execution preflight exercises the shipped PTY and rejects absent/corrupt native code before service admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-native-test-'));
  let admission = 0;
  const deployment = createExecutionDeployment({ link: join(root, 'current'), unit: 'execution.service', coreUnit: 'core.service',
    coreEndpoint: join(root, 'core.sock'), tokenPath: join(root, 'token'), healthUrl: 'http://127.0.0.1:12345/health',
    validate: async () => { admission++; }, restart: async () => { throw new Error('Must not restart in preflight'); } });
  try {
    await mkdir(join(root, 'execution'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ opencraftExecution: { protocolVersion: 1,
      platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, profile: 'daemon' } }));
    for (const file of ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs']) await writeFile(join(root, 'execution', file), '');
    await assert.rejects(deployment.inspect({ releaseRoot: root }), /native preflight failed/);
    assert.equal(admission, 0);
    const native = join(root, 'execution/native/node-pty');
    await cp(new URL('../../node_modules/node-pty', import.meta.url), native, { recursive: true });
    await assertExecutionNativePayload(root);
    await deployment.inspect({ releaseRoot: root });
    assert.equal(admission, 1);
    await rm(join(native, 'build'), { recursive: true, force: true });
    await rm(join(native, 'prebuilds'), { recursive: true, force: true });
    await assert.rejects(deployment.inspect({ releaseRoot: root }), /native preflight failed/);
    assert.equal(admission, 1);
    await mkdir(join(native, 'build/Release'), { recursive: true });
    await writeFile(join(native, 'build/Release/pty.node'), 'incompatible native binary');
    await assert.rejects(deployment.inspect({ releaseRoot: root }), /native preflight failed/);
    assert.equal(admission, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
