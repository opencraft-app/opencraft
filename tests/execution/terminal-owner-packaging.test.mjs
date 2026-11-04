import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, cp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';

const require = createRequire(import.meta.url), root = resolve('.');
const scope = { account: 'alice', hostId: 'host', projectId: 'project', threadId: 'thread' };
const decode = value => value.output.map(chunk => Buffer.from(chunk.deltaBase64, 'base64').toString()).join('');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
async function until(read, predicate) {
  const end = Date.now() + 20_000;
  for (;;) { try { const value = await read(); if (predicate(value)) return value; } catch (error) { if (Date.now() > end) throw error; }
    if (Date.now() > end) throw new Error('Managed terminal smoke timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function rpc(endpoint, method, params = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: endpoint, method: 'POST', path: '/' }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.once('end', () => { if (response.statusCode !== 200) reject(new Error('Host RPC failed')); else resolve(JSON.parse(text).result); });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('Host timeout'))); req.once('error', reject);
    req.end(JSON.stringify({ method, params, scope }));
  });
}

test('packaged owner survives systemd Host control-group stop and deletion of its original release', {
  skip: process.env.OPENCRAFT_TEST_TERMINAL_SYSTEMD !== '1' || process.platform !== 'linux' || process.getuid?.() !== 0,
  timeout: 90_000,
}, async t => {
  const directory = await mkdtemp('/var/lib/opencraft-test-terminal-');
  const oldRelease = join(directory, 'release-one'), nextRelease = join(directory, 'release-two'), data = join(directory, 'data'), endpoint = join(directory, 'host.sock');
  const hostUnit = 'opencraft-test-terminal-' + process.pid;
  let ownerUnit;
  t.after(async () => {
    for (const unit of [hostUnit, ownerUnit].filter(Boolean)) try { run('systemctl', ['stop', unit]); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(oldRelease, { recursive: true });
  await buildTerminalOwnerRuntime(oldRelease);
  await build({ entryPoints: ['tests/execution/fixtures/terminal-host-peer.ts'], outfile: join(oldRelease, 'host.mjs'),
    bundle: true, platform: 'node', format: 'esm', external: ['node-pty'],
    banner: { js: "import {createRequire as _require} from 'node:module'; const require=_require(import.meta.url);" } });
  await cp(dirname(require.resolve('node-pty/package.json')), join(oldRelease, 'node_modules/node-pty'), { recursive: true });
  await cp(oldRelease, nextRelease, { recursive: true });
  const start = release => run('systemd-run', ['--quiet', '--collect', '--service-type=exec', '--unit=' + hostUnit,
    '-p', 'WorkingDirectory=' + root, '-p', 'KillMode=control-group', '-p', 'PrivateTmp=yes', '-p', 'StandardOutput=null', '-p', 'StandardError=null',
    '--setenv=TMPDIR=/tmp', process.execPath, join(release, 'host.mjs'), data, '--http', endpoint]);
  start(oldRelease);
  await until(() => rpc(endpoint, 'process/list'), () => true);
  await rpc(endpoint, 'process/spawn', { processHandle: 'persist', resourceOwnerId: 'conversation', tty: true,
    command: ['/bin/bash', '--noprofile', '--norc'], cwd: '/tmp', size: { cols: 80, rows: 24 } });
  const attach = () => rpc(endpoint, 'process/attach', { processHandle: 'persist', afterSequence: 0 });
  const write = text => rpc(endpoint, 'process/writeStdin', { processHandle: 'persist', deltaBase64: Buffer.from(text).toString('base64') });
  await write("export PRESERVED=yes; printf 'ORIGINAL=%s\\n' $$\n");
  const first = await until(attach, snap => /ORIGINAL=\d+/.test(decode(snap)));
  const shellPid = decode(first).match(/ORIGINAL=(\d+)/)[1];
  const cgroup = await readFile(`/proc/${shellPid}/cgroup`, 'utf8');
  ownerUnit = cgroup.match(/(opencraft-pty-[a-f0-9]+\.service)/)?.[1];
  assert.ok(ownerUnit, 'shell belongs to independent owner systemd unit');
  const ownerPid = run('systemctl', ['show', ownerUnit, '-p', 'MainPID', '--value']);
  assert.ok(Number(ownerPid) > 0);
  const hostGroup = run('systemctl', ['show', hostUnit, '-p', 'ControlGroup', '--value']);
  assert.ok(!cgroup.includes(hostGroup + '/'));
  run('systemctl', ['stop', hostUnit]);
  assert.equal(run('systemctl', ['show', ownerUnit, '-p', 'MainPID', '--value']), ownerPid);
  await rm(oldRelease, { recursive: true, force: true });
  start(nextRelease);
  await until(() => rpc(endpoint, 'process/list'), result => result.processes.some(p => p.processHandle === 'persist'));
  await write("printf 'AFTER=%s VALUE=%s\\n' $$ \"$PRESERVED\"\n");
  const restored = await until(attach, snap => decode(snap).includes(`AFTER=${shellPid} VALUE=yes`));
  assert.equal(restored.phase, 'running');
  // New PTY creation after deleting the old release verifies spawn-helper/native
  // assets, not only already-loaded JS or a single retained process.
  await rpc(endpoint, 'process/spawn', { processHandle: 'after-release-cleanup', tty: true,
    command: ['/bin/sh', '-c', 'printf NATIVE_CLOSURE_OK'], cwd: '/tmp', size: { cols: 80, rows: 24 } });
  await until(() => rpc(endpoint, 'process/attach', { processHandle: 'after-release-cleanup', afterSequence: 0 }), snap => decode(snap).includes('NATIVE_CLOSURE_OK'));
  await rpc(endpoint, 'process/kill', { processHandle: 'persist' });
  await until(attach, snap => snap.phase === 'exited');
  console.log(JSON.stringify({ hostRestart: true, originalReleaseDeleted: true, shellPid, ownerPid, ownerUnit, newPtyAfterCleanup: true }));
});
