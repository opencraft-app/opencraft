import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
// Root tests drop to nobody; nonroot runners instead create owner-unreadable fixtures.
const privateMode = process.getuid?.() === 0 ? 0o600 : 0o000;
const code = readFileSync(new URL('../deploy/docker/deploy/workspace-preflight.mjs', import.meta.url), 'utf8');
function fixture(t) {
  const root = mkdtempSync(join(process.getuid?.() === 0 ? '/var/tmp' : tmpdir(), 'retained-workspace-')); chmodSync(root, 0o755);
  const cwd = join(root, 'work'); mkdirSync(cwd, { mode: 0o777 }); chmodSync(cwd, 0o777);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (rows = [{ cwd }]) => spawnSync(process.execPath, ['--input-type=module', '-e', (process.getuid?.() === 0 ? 'process.setgroups([]); process.setgid(65534); process.setuid(65534);\n' : '') + code, '--', '--retained-workspace-probe'], {
    input: JSON.stringify(rows), encoding: 'utf8',
  });
  return { root, cwd, run };
}
test('real target identity rejects a missing retained cwd and a non-writable old workspace', t => {
  const f = fixture(t);
  { const result = f.run(); assert.equal(result.status, 0, result.stderr); }
  const missing = f.run([{ cwd: join(f.root, 'missing') }]);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ENOENT/);
  chmodSync(f.cwd, 0o555);
  const denied = f.run(); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /EACCES/);
});
test('ancestor project config and nested rules must be readable without exposing file contents', t => {
  const f = fixture(t), codex = join(f.root, '.codex'); mkdirSync(codex, { mode: 0o755 });
  const config = join(codex, 'config.toml'); writeFileSync(config, 'synthetic-private-marker', { mode: privateMode });
  assert.notEqual(f.run().status, 0); assert.equal(f.run().stderr.includes('synthetic-private-marker'), false);
  chmodSync(config, 0o644);
  const rules = join(codex, 'rules'); mkdirSync(rules, { mode: 0o755 });
  const rule = join(rules, 'default.rules'); writeFileSync(rule, 'rule', { mode: privateMode });
  assert.notEqual(f.run().status, 0); chmodSync(rule, 0o644);
  // An unreadable auth store is deliberately outside the probe's authority.
  writeFileSync(join(codex, 'auth.json'), 'synthetic-auth', { mode: privateMode });
  { const result = f.run(); assert.equal(result.status, 0, result.stderr); }
});
test('selected shared resources follow real symlinks and reject inaccessible Git metadata', t => {
  const f = fixture(t), git = join(f.root, 'git'); mkdirSync(git, { mode: 0o755 });
  const index = join(git, 'index'); writeFileSync(index, 'index', { mode: privateMode });
  const alias = join(f.root, 'skills'); symlinkSync(git, alias);
  const rows = [{ cwd: f.cwd, readablePaths: [alias] }];
  assert.notEqual(f.run(rows).status, 0); chmodSync(index, 0o644);
  symlinkSync(git, join(git, 'cycle'));
  { const result = f.run(rows); assert.equal(result.status, 0, result.stderr); }
  const aliasCwd = join(f.root, 'work-alias'); symlinkSync(f.cwd, aliasCwd);
  assert.equal(f.run([{ cwd: aliasCwd }]).status, 0);
});

test('workspace authority preflight checks the Gateway path and preserves the live socket', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'workspace-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'run'), alias = join(root, 'alias');
  mkdirSync(directory, { mode: 0o700 });
  symlinkSync(directory, alias);
  const socket = join(directory, 'authority.sock');
  const clientPath = join(alias, 'authority.sock');
  const probe = (mode, role, path) =>
    ['--input-type=module', '-e', code, '--', mode, role, path, 'fixture-token'];
  const gatewayAlias = spawnSync(process.execPath, probe('--authority-path-probe', 'gateway', clientPath), { encoding: 'utf8' });
  assert.notEqual(gatewayAlias.status, 0);
  assert.match(gatewayAlias.stderr, /Gateway must use its real path/);
  chmodSync(directory, 0o755);
  const publicDirectory = spawnSync(process.execPath, probe('--authority-path-probe', 'brain', clientPath), { encoding: 'utf8' });
  assert.notEqual(publicDirectory.status, 0);
  assert.match(publicDirectory.stderr, /private directory/);
  chmodSync(directory, 0o700);

  const live = createServer();
  await once(live.listen(socket), 'listening');
  t.after(() => live.close());
  chmodSync(socket, 0o600);
  const inode = statSync(socket).ino;
  const gateway = spawn(process.execPath, probe('--authority-socket-probe', 'gateway', socket));
  const exited = once(gateway, 'exit');
  try {
    await once(gateway.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
    const brain = spawnSync(process.execPath, probe('--authority-socket-probe', 'brain', clientPath), { encoding: 'utf8', timeout: 5_000 });
    assert.equal(brain.status, 0, brain.stderr);
    assert.match(brain.stdout, /Brain reached the Gateway socket listener/);
  } finally {
    gateway.kill('SIGTERM');
    await exited;
  }
  assert.equal(statSync(socket).ino, inode);
  assert.deepEqual(readdirSync(directory), ['authority.sock']);
});
