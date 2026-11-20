import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { CodexCoreControlClient } from '@opencraft/account-pool-host';
import { startCodexAppServer, type CodexAppServerOptions } from '../../apps/codex-core/src/app-server.js';
import { SystemdGenerationSupervisor } from '../../apps/codex-core/src/generation-supervisor.js';
import type { GenerationRecord } from '../../apps/codex-core/src/generation-registry.js';

const base: CodexAppServerOptions = { endpoint: '/unused/app.sock', coreEndpoint: '/unused/core.sock',
  dataDirectory: '/unused/data', runtimeDirectory: '/unused/runtime', executable: '/unused/codex', authToken: 'x'.repeat(32) };

test('APP rejects configured-but-invalid workspace authority before any runtime write', async () => {
  const executionSandbox = {} as NonNullable<CodexAppServerOptions['executionSandbox']>;
  for (const workspaceAuthoritySocket of ['', 'relative.sock', '/bad\0socket', '/' + 'x'.repeat(103)])
    await assert.rejects(startCodexAppServer({ ...base, executionSandbox, workspaceAuthoritySocket }), /Invalid private workspace authority/);
  await assert.rejects(startCodexAppServer({ ...base, workspaceAuthoritySocket: '/private/authority.sock' }), /Invalid private workspace authority/);
});

test('actual APP launch entry forwards the private deployment channel, with no implicit default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-workspace-launch-'));
  try {
    const output = join(root, 'launch.cjs'), token = join(root, 'token');
    await writeFile(token, 'x'.repeat(32), { mode: 0o600 });
    await build({ entryPoints: [resolve('apps/codex-core/src/app-server-bin.ts')], outfile: output,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'launch-boundary', setup(b) {
        b.onResolve({ filter: /^\.\/app-server\.js$/ }, () => ({ path: 'runtime', namespace: 'mock' }));
        b.onResolve({ filter: /^@opencraft\/sandbox-node\/engine$/ }, () => ({ path: 'engine', namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: a.path === 'engine'
          ? 'export async function engineSandboxConfiguration(){return "/private/policy.json"}'
          : 'export async function startCodexAppServer(o){console.log(JSON.stringify({socket:o.workspaceAuthoritySocket??null,sandbox:!!o.executionSandbox}));return {close:async()=>{}}}' }));
      } }] });
    const env = { ...process.env }; delete env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET;
    const args = [output, '--endpoint', '/private/app.sock', '--core-endpoint', '/private/core.sock', '--token-file', token,
      '--data-directory', root, '--runtime-directory', root, '--codex-executable', '/private/codex'];
    const run = async (e: NodeJS.ProcessEnv) => JSON.parse((await promisify(execFile)(process.execPath, args, { env: e })).stdout.split('\n')[0]!);
    assert.deepEqual(await run(env), { socket: null, sandbox: true });
    assert.deepEqual(await run({ ...env, OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET: '/private/authority.sock' }),
      { socket: '/private/authority.sock', sandbox: true });
    // Empty is forwarded, not coerced into disabled mode; APP validation rejects it.
    assert.equal((await run({ ...env, OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET: '' })).socket, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed cross-user generation cannot silently discard configured authority', async () => {
  const key = 'OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET', previous = process.env[key];
  process.env[key] = '/private/authority.sock';
  try {
    const supervisor = new SystemdGenerationSupervisor({ registryDirectory: '/private/registry', coreEndpoint: '/private/core.sock',
      dataDirectory: '/private/data', tokenFile: '/private/token', token: 'x'.repeat(32), scope: 'system' });
    // Probe only the unstarted-generation admission branch; no systemctl or cloud calls.
    Object.assign(supervisor, { health: async () => { throw Error('not started'); },
      unitState: async () => ({ pid: 0, active: 'inactive', file: '' }) });
    const g = { id: 'test', state: 'candidate', node: '/opt/node', bundle: '/opt/app', executable: '/opt/codex',
      cwd: '/opt/runtime', runtimeDataDirectory: '/private/runtime', endpoint: '/private/app.sock',
      executionUid: process.getuid!() + 1, executionGid: process.getgid!() } as GenerationRecord;
    await assert.rejects(supervisor.start(g), /requires a same-user generation/);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test('configured authority refuses a healthy legacy APP rather than accepting local execution', async t => {
  const key = 'OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET', previous = process.env[key];
  const supervisor = new SystemdGenerationSupervisor({ registryDirectory: '/private/registry', coreEndpoint: '/private/core.sock',
    dataDirectory: '/private/data', tokenFile: '/private/token', token: 'x'.repeat(32), scope: 'system' });
  let capable = false;
  t.mock.method(CodexCoreControlClient.prototype, 'appServerHealth', async () => ({ protocolVersion: 1,
    ...(capable ? { workspaceExecutionVersion: 1 } : {}) }));
  const g = { endpoint: '/private/app.sock' } as GenerationRecord;
  try {
    delete process.env[key];
    assert.equal((await supervisor.inspect(g)).protocolVersion, 1);
    process.env[key] = '/private/authority.sock';
    await assert.rejects(supervisor.inspect(g), /does not support configured private workspace authority/);
    capable = true;
    assert.equal((await supervisor.inspect(g)).workspaceExecutionVersion, 1);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});
