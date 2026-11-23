import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { startCodexAppServer, type CodexAppServerOptions } from '../../apps/codex-core/src/app-server.js';

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

