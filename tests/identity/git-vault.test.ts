import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import nodeTest from 'node:test';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store';
import { createMemoryGitSigner, generateGitSigningKey, sshString } from '../../scripts/git-identity-signer';
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

const credential = () => ({ identity: { username: 'synthetic', name: 'Synthetic Employee', email: 'synthetic@example.test' }, token: 'synthetic-token-only', signing: null });
test('a managed data-directory alias shares its canonical vault but never follows a key symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-vault-alias-')); t.after(() => rm(root, { recursive: true, force: true }));
  const physical = join(root, 'physical'), alias = join(root, 'alias'); await mkdir(physical, { mode: 0o700 }); await symlink(physical, alias);
  const first = new EmployeeGitVaultStore(alias); first.write('employee:1', 'github.com', 0, credential()); first.close();
  const second = new EmployeeGitVaultStore(physical); assert.equal(second.status('employee:1', 'github.com').revision, 1); second.close();
  const key = join(physical, 'employee-git-vault.key'); assert.equal((await stat(key)).mode & 0o077, 0);
  await rename(key, key + '.saved'); await symlink(key + '.saved', key);
  assert.throws(() => new EmployeeGitVaultStore(alias));
});
test('vault encrypts, binds account/host with AAD, persists CAS tombstones and rejects checksum mismatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-vault-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let store = new EmployeeGitVaultStore(root);
  assert.equal(store.outcome.status, 'fresh');
  assert.equal(store.status('employee:1', 'github.com').configured, false);
  store.write('employee:1', 'github.com', 0, credential());
  assert.throws(() => store.write('employee:1', 'github.com', 0, credential()), /conflict/);
  assert.equal(store.status('employee:2', 'github.com').configured, false);
  store.close(); store = new EmployeeGitVaultStore(root);
  assert.equal(store.outcome.status, 'up-to-date');
  assert.equal(store.read('employee:1', 'github.com').credential?.token === credential().token, true);
  store.write('employee:1', 'github.com', 1, null);
  assert.equal(store.status('employee:1', 'github.com').revision, 2);
  assert.throws(() => store.write('employee:1', 'github.com', 0, credential()), /conflict/);
  store.write('employee:1', 'github.com', 2, credential()); store.close();
  for (const filename of await readdir(root)) {
    const bytes = await readFile(join(root, filename));
    assert.equal(bytes.includes(Buffer.from(credential().token)), false);
    assert.equal((await stat(join(root, filename))).mode & 0o077, 0);
  }
  const db = new DatabaseSync(join(root, 'employee-git-vault.sqlite'));
  db.prepare('UPDATE employee_git_credentials SET account=?').run('employee:2'); db.close();
  store = new EmployeeGitVaultStore(root);
  assert.throws(() => store.read('employee:2', 'github.com')); store.close();
  const corrupt = new DatabaseSync(join(root, 'employee-git-vault.sqlite'));
  corrupt.prepare('UPDATE schema_migrations SET checksum=?').run('invalid'); corrupt.close();
  assert.throws(() => new EmployeeGitVaultStore(root));
});
test('nonempty vault never recreates a lost encryption key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-vault-key-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EmployeeGitVaultStore(root); store.write('employee:1', 'github.com', 0, credential()); store.close();
  await unlink(join(root, 'employee-git-vault.key'));
  assert.throws(() => new EmployeeGitVaultStore(root));
  await assert.rejects(stat(join(root, 'employee-git-vault.key')));
});
async function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [], err: Buffer[] = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(err).toString()); return Buffer.concat(out).toString().trim();
}
test('real Git signs through memory-only agent and verifies its SSH signature', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-signer-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const signing = generateGitSigningKey(), signer = await createMemoryGitSigner(signing, root); t.after(() => signer.close());
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SSH_AUTH_SOCK: signer.path,
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.test', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.test' };
  await run('git', ['init', '-q', root], env, root);
  await run('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=key::${signing.publicKey}`, '-c', 'commit.gpgsign=true', 'commit', '--allow-empty', '-qm', 'synthetic signed commit'], env, root);
  await writeFile(join(root, 'allowed'), `synthetic@example.test ${signing.publicKey}\n`);
  await run('git', ['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${join(root, 'allowed')}`, 'verify-commit', 'HEAD'], env, root);
  for (const entry of await readdir(root)) {
    if ((await stat(join(root, entry))).isFile()) assert.equal((await readFile(join(root, entry))).includes(Buffer.from('BEGIN PRIVATE KEY')), false);
  }
});
test('SIGKILL leaves only a socket, never a plaintext signing key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-signer-kill-')); t.after(() => rm(root, { recursive: true, force: true }));
  const worker = resolve('scripts/git-identity-signer.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {createMemoryGitSigner,generateGitSigningKey} from ${JSON.stringify(worker)};await createMemoryGitSigner(generateGitSigningKey(),process.argv[1]);process.stdout.write('ready\\n');setInterval(()=>{},1000);`, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await once(child, 'close');
  const files = await readdir(root, { recursive: true });
  assert.equal(files.some(p => /key|pem/i.test(p)), false);
  for (const entry of files) {
    const info = await stat(join(root, entry));
    assert.equal(info.isFile(), false); assert.equal(info.isDirectory() || info.isSocket(), true);
  }
});
test('signer rechecks live command authority and refuses authentication/non-Git payloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-sign-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  let allowed = false;
  const signing = generateGitSigningKey(), signer = await createMemoryGitSigner(signing, root, 30_000, async () => allowed); t.after(() => signer.close());
  const request = (payload: Buffer) => new Promise<number>((resolve, reject) => {
    const socket = createConnection(signer.path); let pending = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Agent timeout')); }, 2000);
    socket.once('error', reject); socket.once('connect', () => socket.write(sshString(Buffer.concat([Buffer.from([13]), sshString(Buffer.from(signing.publicKey.split(' ')[1]!, 'base64')), sshString(payload), Buffer.alloc(4)]))));
    socket.on('data', data => { pending = Buffer.concat([pending, data]); if (pending.length >= 5 && pending.length >= pending.readUInt32BE(0) + 4) { clearTimeout(timer); socket.destroy(); resolve(pending[4]!); } });
  });
  const gitPayload = Buffer.concat([Buffer.from('SSHSIG'), sshString('git'), sshString(''), sshString('sha512'), sshString(Buffer.alloc(64))]);
  assert.equal(await request(gitPayload), 5); allowed = true; assert.equal(await request(gitPayload), 14);
  assert.equal(await request(Buffer.from('SSH authentication challenge')), 5);
});
