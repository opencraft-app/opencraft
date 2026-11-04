import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import nodeTest from 'node:test';
import { build } from 'esbuild';
import ssh2 from 'ssh2';
const { Server: SshServer, utils: sshUtils } = ssh2;
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store';
import { GitIdentityBroker, type GitExecutionIdentity } from '../../scripts/git-identity-broker';
import { queryGitIdentityBroker, serveGitIdentityBroker } from '../../scripts/git-identity-ipc';
import { exactGitHost, gitConfigParameter, parseGitInvocation, personalHttpsRemote } from '../../scripts/git-identity-wrapper';
import { managedGitEnvironment } from '../../scripts/git-identity-environment';
import { renderGitIdentityInstallation } from '../../scripts/git-identity-installation';
import { GitBrokerOwner } from '../../scripts/git-broker-owner';
import { generateGitSigningKey } from '../../scripts/git-identity-signer';
// SO_PEERCRED and /proc are the supported local Linux execution boundary.
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

async function fixture(t: any, httpsCredentialHosts?: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), 'git-broker-test-'));
  const store = new EmployeeGitVaultStore(root); let identity: GitExecutionIdentity = { status: 'active', account: 'synthetic:1', executionId: 'turn1' };
  const broker = new GitIdentityBroker({ store, httpsCredentialHosts, hosts: ['github.com', 'git.example.test', 'unconfigured.example.test'], runtimeDirectory: root, resolve: async () => identity });
  const opens: string[] = []; let credentials = 0;
  const request = broker.request.bind(broker);
  broker.request = async (peer, value) => {
    if (value && typeof value === 'object' && 'op' in value) {
      if (value.op === 'open' && 'host' in value) opens.push(String(value.host));
      if (value.op === 'credential') credentials++;
    }
    return request(peer, value);
  };
  const socket = join(root, 'broker.sock'), ipc = await serveGitIdentityBroker(broker, socket, resolve('scripts/git-identity-peer-bridge.py'));
  t.after(async () => { await ipc.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, socket, store, opens, credentials: () => credentials, setIdentity: (value: GitExecutionIdentity) => { identity = value; } };
}
test('broker distinguishes unconfigured/configured/unavailable/expired and exact final host', async t => {
  const f = await fixture(t);
  assert.deepEqual(await queryGitIdentityBroker(f.socket, { op: 'health' }), { status: 'ready', commandSessions: 0 });
  const open = () => queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'synthetic-thread', host: 'github.com' });
  assert.equal((await open()).status, 'unconfigured');
  f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Synthetic', email: 'synthetic@example.test' }, token: 'synthetic-only', signing: null });
  const session = await open(); assert.equal(session.status, 'configured'); assert.equal('password' in session, false);
  const credential = (host: string, protocol = 'https') => queryGitIdentityBroker(f.socket, { op: 'credential', sessionId: session.sessionId, host, protocol });
  assert.equal((await credential('github.com')).status, 'configured');
  for (const host of ['github.com.evil.test', 'evilgithub.com', 'github.com:443', 'GITHUB.COM', 'other.example.test']) assert.equal((await credential(host)).status, 'denied');
  assert.equal((await credential('github.com', 'http')).status, 'denied');
  f.setIdentity({ status: 'active', account: 'synthetic:1', executionId: 'next-turn' });
  assert.equal((await credential('github.com')).status, 'expired', 'an old command cannot borrow the next Turn');
  f.setIdentity({ status: 'unknown' }); assert.equal((await credential('github.com')).status, 'unavailable');
  f.setIdentity({ status: 'active', account: 'synthetic:1', executionId: 'turn1' });
  f.store.write('synthetic:1', 'github.com', 1, null); assert.equal((await credential('github.com')).status, 'expired');
  f.setIdentity({ status: 'unknown' }); assert.equal((await open()).status, 'unconfigured');
  f.setIdentity({ status: 'expired' }); assert.equal((await open()).status, 'unconfigured');
  f.setIdentity({ status: 'unowned' }); assert.equal((await open()).status, 'unconfigured');
});
test('an entirely unbound host keeps server Git available when origin lookup is unavailable', async t => {
  const f = await fixture(t);
  const open = () => queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'existing-thread', host: 'github.com' });
  f.setIdentity({ status: 'unknown' });
  assert.equal((await open()).status, 'unconfigured');
  f.store.write('synthetic:other', 'github.com', 0, { identity: { username: 'other', name: 'Other', email: 'other@example.test' }, token: 'synthetic-only', signing: null });
  assert.equal((await open()).status, 'unavailable', 'a host with any binding still requires an attested account');
  assert.equal((await queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'existing-thread', host: 'unconfigured.example.test' })).status, 'unconfigured');
  f.store.write('synthetic:other', 'github.com', 1, null);
  assert.equal((await open()).status, 'unconfigured', 'a cleared binding is absent');
});
test('an unbound host answers before a stalled execution origin lookup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-unbound-stalled-'));
  const store = new EmployeeGitVaultStore(root); let lookups = 0;
  const broker = new GitIdentityBroker({ store, hosts: ['github.com'], runtimeDirectory: root,
    resolve: async () => { lookups++; return new Promise(() => {}); } });
  const socket = join(root, 'broker.sock'), ipc = await serveGitIdentityBroker(broker, socket, resolve('scripts/git-identity-peer-bridge.py'));
  t.after(async () => { await ipc.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await queryGitIdentityBroker(socket, { op: 'open', threadId: 'existing-session', host: 'github.com' }, 250)).status, 'unconfigured');
  assert.equal(lookups, 0);
});
async function child(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string) {
  const p = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }); const out: Buffer[] = [], err: Buffer[] = [];
  p.stdout.on('data', b => out.push(b)); p.stderr.on('data', b => err.push(b)); p.stdin.end(input);
  const [code] = await once(p, 'close'); return { code, out: Buffer.concat(out).toString().trim(), err: Buffer.concat(err).toString() };
}
test('real wrapper preserves original authors on amend/cherry-pick/rebase and never reruns failed Git', async t => {
  const f = await fixture(t), work = join(f.root, 'repo');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Original', GIT_AUTHOR_EMAIL: 'original@example.test', GIT_COMMITTER_NAME: 'Server', GIT_COMMITTER_EMAIL: 'server@example.test' };
  const git = async (...args: string[]) => child('/usr/bin/git', args, env, work);
  await child('/usr/bin/git', ['init', '-q', work], env, f.root);
  await git('remote', 'add', 'origin', 'https://github.com/synthetic/fixture.git');
  const managedEnv = { ...env, CODEX_THREAD_ID: 'synthetic-thread', OPENCRAFT_GIT_NATIVE: '/usr/bin/git', OPENCRAFT_GIT_BROKER_SOCKET: f.socket };
  const wrapper = join(f.root, 'git-identity-wrapper.mjs');
  await build({ entryPoints: [resolve('scripts/git-identity-wrapper.ts')], outfile: wrapper, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const managed = (...args: string[]) => child(process.execPath, [wrapper, ...args], managedEnv, work);
  assert.equal((await managed('commit', '--allow-empty', '-qm', 'unconfigured')).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Original|Server');
  f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Employee', email: 'employee@example.test' }, token: 'synthetic-only', signing: null });
  assert.equal((await managed('commit', '--allow-empty', '-qm', 'configured')).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Employee|Employee');
  const hook = join(work, '.git/hooks/pre-commit');
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(hook, `#!/bin/sh\nset -eu\ntest -z "$(/usr/bin/git config --get-urlmatch http.extraHeader https://github.com/synthetic/fixture.git)"\nprintf 'protocol=https\\nhost=github.com\\n\\n' | /usr/bin/git credential fill | ${node} -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{if(!s.includes("username=synthetic")||!s.includes("password=synthetic-only"))process.exit(1)})'\n`, { mode: 0o700 });
  await git('config', 'credential.helper', '!exit 23');
  await git('config', 'http.https://github.com/.extraHeader', 'Authorization: SyntheticOldHeader');
  const withHelper = await managed('commit', '--allow-empty', '-qm', 'helper protocol');
  assert.equal(withHelper.code, 0, withHelper.err);
  await rm(hook);
  await git('commit', '--allow-empty', '-qm', 'original authored');
  assert.equal((await managed('commit', '--amend', '--allow-empty', '-qm', 'amended')).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Original|Employee');
  const original = (await git('rev-parse', 'HEAD')).out;
  await git('checkout', '-qb', 'pick', 'HEAD~1');
  assert.equal((await managed('cherry-pick', '--allow-empty', original)).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Original|Employee');
  await git('branch', 'base', 'HEAD~1'); await git('checkout', '-q', 'base');
  await git('commit', '--allow-empty', '-qm', 'base advanced');
  await git('checkout', '-q', 'pick');
  assert.equal((await managed('rebase', '--keep-empty', 'base')).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Original|Employee');
  await writeFile(join(work, 'synthetic.txt'), 'synthetic change'); await git('add', 'synthetic.txt'); await git('commit', '-qm', 'original change');
  assert.equal((await managed('revert', '--no-edit', 'HEAD')).code, 0);
  assert.equal((await git('show', '-s', '--format=%an|%cn')).out, 'Employee|Employee');
  f.setIdentity({ status: 'unknown' });
  const before = (await git('rev-parse', 'HEAD')).out;
  const result = await managed('commit', '--allow-empty', '-qm', 'must not commit');
  assert.equal(result.code, 128); assert.match(result.err, /refusing server-account fallback/u);
  assert.equal((await git('rev-parse', 'HEAD')).out, before);
  delete (managedEnv as NodeJS.ProcessEnv).CODEX_THREAD_ID;
  (managedEnv as NodeJS.ProcessEnv).OPENCRAFT_GIT_MANAGED = '1';
  assert.equal((await managed('commit', '--allow-empty', '-qm', 'missing execution context')).code, 128);
  assert.equal((await managed('status', '--short')).code, 0, 'read-only commands remain available without credentials');
  assert.equal((await git('rev-parse', 'HEAD')).out, before);
  managedEnv.OPENCRAFT_GIT_BROKER_SOCKET = join(f.root, 'missing.sock');
  managedEnv.CODEX_THREAD_ID = 'synthetic-thread';
  const unavailable = await managed('commit', '--allow-empty', '-qm', 'broker down');
  assert.equal(unavailable.code, 128); assert.match(unavailable.err, /broker unavailable/u);
  assert.equal((await git('rev-parse', 'HEAD')).out, before);
});
test('config encoding and Git global options retain exact worktree context', () => {
  assert.equal(personalHttpsRemote('git@github.com:synthetic/repo.git', 'github.com'), 'https://github.com/synthetic/repo.git');
  assert.equal(personalHttpsRemote('ssh://git@github.com/synthetic/repo.git', 'github.com'), 'https://github.com/synthetic/repo.git');
  for (const u of ['git@github.com.evil.test:repo', 'git@alias:repo', 'ssh://git@github.com:2222/repo', 'ssh://other@github.com/repo', 'git@github.com:../repo', 'git@github.com:repo%2fsecret']) assert.equal(personalHttpsRemote(u, 'github.com'), null);
  assert.equal(exactGitHost('https://github.com.evil.test/repo'), 'github.com.evil.test');
  assert.equal(exactGitHost('git@github.com:synthetic/repo'), 'github.com');
  assert.deepEqual(parseGitInvocation(['-C', '/synthetic directory', '--git-dir=/synthetic/.git', 'commit', '-m', 'x']), { prefix: ['-C', '/synthetic directory', '--git-dir=/synthetic/.git'], command: 'commit', tail: ['-m', 'x'] });
  assert.equal(gitConfigParameter('credential.helper', ''), "'credential.helper='");
});
test('managed constants survive a login bash profile without changing the global shell environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-login-env-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nprintf managed\\n\n', { mode: 0o700 });
  const before = process.env.PATH;
  const env = managedGitEnvironment(process.env, { binDirectory: bin, nativeGit: '/usr/bin/git', brokerSocket: join(root, 'broker.sock'), hosts: ['github.com'], bashEnvironment: resolve('scripts/git-identity-shell-env.sh') });
  const result = await child('/bin/bash', ['-lc', 'command -v git'], env, root);
  assert.equal(result.code, 0); assert.equal(result.out, join(bin, 'git'));
  assert.equal(process.env.PATH, before);
});
async function managedRepository(t: any) {
  const f = await fixture(t), work = join(f.root, 'repo');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic Server', GIT_AUTHOR_EMAIL: 'server@example.test', GIT_COMMITTER_NAME: 'Synthetic Server', GIT_COMMITTER_EMAIL: 'server@example.test' };
  await child('/usr/bin/git', ['init', '-q', work], env, f.root);
  const native = (...args: string[]) => child('/usr/bin/git', args, env, work);
  await native('symbolic-ref', 'HEAD', 'refs/heads/main'); await native('commit', '--allow-empty', '-qm', 'initial');
  const wrapper = join(f.root, 'git.mjs'); await build({ entryPoints: [process.env.OPENCRAFT_TEST_GIT_WRAPPER_SOURCE || resolve('scripts/git-identity-wrapper.ts')], outfile: wrapper, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const managedEnv: NodeJS.ProcessEnv = { ...env, CODEX_THREAD_ID: 'synthetic-thread', OPENCRAFT_GIT_MANAGED: '1', OPENCRAFT_GIT_NATIVE: '/usr/bin/git', OPENCRAFT_GIT_BROKER_SOCKET: f.socket, OPENCRAFT_GIT_HOSTS: 'github.com,unconfigured.example.test' };
  const managed = (...args: string[]) => child(process.execPath, [wrapper, ...args], managedEnv, work);
  const bind = () => f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Employee', email: 'employee@example.test' }, token: 'synthetic-only', signing: null });
  return { ...f, env, work, native, managed, managedEnv, bind };
}
test('default fetch/pull use the fetch remote while an unconfigured push target keeps legacy behavior', async t => {
  const f = await managedRepository(t); f.bind();
  await f.native('remote', 'add', 'origin', 'git@github.com:synthetic/repo');
  await f.native('remote', 'add', 'publishing', 'git@unconfigured.example.test:synthetic/repo');
  await f.native('config', 'branch.main.remote', 'origin'); await f.native('config', 'branch.main.pushRemote', 'publishing');
  await f.native('config', 'remote.pushDefault', 'publishing');
  await f.native('config', 'push.default', 'current');
  const marker = join(f.root, 'ssh-invoked'), ssh = join(f.root, 'synthetic-ssh');
  await writeFile(ssh, '#!/bin/sh\nprintf invoked >> "$SYNTHETIC_SSH_MARKER"\nexit 1\n', { mode: 0o700 });
  f.managedEnv.GIT_SSH_COMMAND = ssh; f.managedEnv.SYNTHETIC_SSH_MARKER = marker;
  await f.native('config', 'http.proxy', 'http://127.0.0.1:1'); // No external network in this routing-negative fixture.
  for (const command of ['fetch', 'pull']) {
    f.opens.length = 0; const result = await f.managed(command);
    assert.notEqual(result.code, 0); assert.deepEqual(f.opens, ['github.com']);
    await assert.rejects(readFile(marker));
  }
  f.opens.length = 0; await f.managed('push');
  assert.deepEqual(f.opens, ['unconfigured.example.test']); assert.equal((await readFile(marker, 'utf8')).includes('invoked'), true);
});
test('native insteadOf and pushInsteadOf expansion cannot enter inherited SSH authentication', async t => {
  const f = await managedRepository(t); f.bind();
  const marker = join(f.root, 'ssh-invoked'), ssh = join(f.root, 'synthetic-ssh');
  await writeFile(ssh, '#!/bin/sh\nprintf invoked >> "$SYNTHETIC_SSH_MARKER"\nexit 1\n', { mode: 0o700 });
  f.managedEnv.GIT_SSH_COMMAND = ssh; f.managedEnv.SYNTHETIC_SSH_MARKER = marker;
  await f.native('config', 'url.git@github.com:.insteadOf', 'https://github.com/');
  const fetch = await f.managed('ls-remote', 'https://github.com/synthetic/repo');
  assert.equal(fetch.code, 128); assert.match(fetch.err, /matching HTTPS remote/u); await assert.rejects(readFile(marker));
  await f.native('config', '--unset', 'url.git@github.com:.insteadOf');
  await f.native('config', 'url.git@github.com:.pushInsteadOf', 'https://github.com/');
  await f.native('config', 'url.https://unconfigured.example.test/.insteadOf', 'https://github.com/');
  const push = await f.managed('push', 'https://github.com/synthetic/repo', 'HEAD:main');
  assert.equal(push.code, 128); assert.match(push.err, /matching HTTPS remote/u); await assert.rejects(readFile(marker));
});
test('configured HTTPS cannot authenticate from server netrc before the broker', async t => {
  const f = await managedRepository(t), home = join(f.root, 'home'); await mkdir(home);
  f.managedEnv.HOME = home; f.managedEnv.NO_PROXY = '';
  await writeFile(join(home, '.netrc'), 'machine github.com login synthetic-server password synthetic-server-only\n', { mode: 0o600 });
  const generated = await child('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-', '-subj', '/CN=github.com', '-days', '1'], f.env, f.root);
  assert.equal(generated.code, 0);
  const key = generated.out.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/u)?.[0];
  const cert = generated.out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u)?.[0];
  assert.ok(!!key && !!cert);
  const received: string[] = [], sockets = new Set<Socket>();
  const https = createHttpsServer({ key, cert }, (request, response) => {
    if (!request.headers.authorization) { response.writeHead(401, { 'www-authenticate': 'Basic realm="synthetic"' }); response.end(); return; }
    received.push(request.headers.authorization); response.writeHead(404); response.end('synthetic repository');
  });
  const proxy = createHttpServer();
  for (const server of [https, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  https.listen(0, '127.0.0.1'); await once(https, 'listening');
  proxy.on('connect', (_request, socket, head) => {
    const upstream = connectTcp((https.address() as any).port, '127.0.0.1'); sockets.add(upstream);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('close', () => sockets.delete(upstream));
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([https, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
  await f.native('config', 'http.proxy', `http://127.0.0.1:${(proxy.address() as any).port}`); await f.native('config', 'http.sslVerify', 'false');
  await f.native('remote', 'add', 'origin', 'https://github.com/synthetic/repo');
  await f.managed('ls-remote', 'origin');
  assert.equal(received.some(auth => auth === `Basic ${Buffer.from('synthetic-server:synthetic-server-only').toString('base64')}`), true, 'unconfigured mode retains existing netrc behavior');
  received.length = 0; f.bind();
  const authenticated = await f.managed('ls-remote', 'origin');
  assert.equal(received.some(auth => auth === `Basic ${Buffer.from('synthetic-server:synthetic-server-only').toString('base64')}`), false);
  assert.equal(received.some(auth => auth === `Basic ${Buffer.from('synthetic:synthetic-only').toString('base64')}`), true, authenticated.err);
  assert.equal(f.credentials() > 0, true);
  for (const key of ['credential.username', 'credential.https://github.com.username']) {
    await f.native('config', key, 'synthetic-server'); received.length = 0;
    await f.managed('ls-remote', 'origin');
    assert.equal(received.some(auth => auth === `Basic ${Buffer.from('synthetic:synthetic-only').toString('base64')}`), true, 'inherited username must not replace the employee identity');
  }
  const missingCertificate = join(f.root, 'synthetic-missing-client-certificate');
  for (const key of ['http.sslCert', 'http.sslKey', 'http.https://github.com.sslCert', 'http.https://github.com.sslKey']) await f.native('config', key, missingCertificate);
  f.managedEnv.GIT_SSL_CERT = missingCertificate; f.managedEnv.GIT_SSL_KEY = missingCertificate; received.length = 0;
  const certificateConflict = await f.managed('ls-remote', 'origin');
  assert.equal(certificateConflict.code, 128);
  assert.match(certificateConflict.err, /conflicting client-certificate authentication/u);
  assert.equal(received.length, 0, 'inherited client certificate authentication must not take over');
});
test('command-private HOME retains read-only global Git policy and is removed after completion', async t => {
  const f = await managedRepository(t); f.bind();
  const home = join(f.root, 'home'), xdg = join(home, '.config'); await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(join(home, '.gitconfig'), '[core]\n\tabbrev = 12\n'); await writeFile(join(xdg, 'git/config'), '[fetch]\n\tprune = true\n');
  delete f.managedEnv.GIT_CONFIG_GLOBAL; f.managedEnv.HOME = home; f.managedEnv.XDG_CONFIG_HOME = xdg;
  await f.native('remote', 'add', 'origin', 'https://github.com/synthetic/repo');
  const marker = join(f.root, 'command-home'); f.managedEnv.SYNTHETIC_HOME_RESULT = marker;
  await writeFile(join(f.work, '.git/hooks/pre-commit'), '#!/bin/sh\nset -eu\ntest "$(/usr/bin/git config --get core.abbrev)" = 12\ntest "$(/usr/bin/git config --get fetch.prune)" = true\nprintf %s "$HOME" > "$SYNTHETIC_HOME_RESULT"\n', { mode: 0o700 });
  const result = await f.managed('commit', '--allow-empty', '-qm', 'global policy'); assert.equal(result.code, 0, result.err);
  const commandHome = await readFile(marker, 'utf8'); assert.notEqual(commandHome, home);
  await assert.rejects(readFile(join(commandHome, 'global.config')), { code: 'ENOENT' });
  assert.equal((await readFile(join(home, '.gitconfig'), 'utf8')), '[core]\n\tabbrev = 12\n');
});
test('wrapped GitHub commit signs and verifies with a command-private HOME', async t => {
  const f = await managedRepository(t), signing = generateGitSigningKey();
  f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Employee', email: 'employee@example.test' }, token: 'synthetic-only', signing });
  await f.native('remote', 'add', 'origin', 'https://github.com/synthetic/repo');
  const result = await f.managed('commit', '--allow-empty', '-qm', 'signed through managed wrapper'); assert.equal(result.code, 0, result.err);
  const allowed = join(f.root, 'allowed-signers'); await writeFile(allowed, `employee@example.test ${signing.publicKey}\n`);
  const verified = await f.native('-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', 'HEAD'); assert.equal(verified.code, 0, verified.err);
});

test('bound SSH remote uses personal HTTPS for real push/delete without changing config or invoking machine SSH', async t => {
  const f = await managedRepository(t); f.bind();
  const bare = join(f.root, 'http-root/synthetic/repo.git'); await mkdir(join(f.root, 'http-root/synthetic'), { recursive: true });
  await child('/usr/bin/git', ['init', '--bare', '-q', bare], f.env, f.root); await child('/usr/bin/git', ['--git-dir', bare, 'config', 'http.receivepack', 'true'], f.env, f.root);
  const pem = await child('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-', '-subj', '/CN=github.com', '-days', '1'], f.env, f.root);
  const key = pem.out.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/u)?.[0], cert = pem.out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u)?.[0]; assert.ok(key && cert);
  const expected = `Basic ${Buffer.from('synthetic:synthetic-only').toString('base64')}`, received: string[] = [], sockets = new Set<Socket>();
  const https = createHttpsServer({ key, cert }, (req, res) => {
    if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }); res.end(); return; }
    received.push(req.headers.authorization); if (req.headers.authorization !== expected) { res.writeHead(403); res.end(); return; }
    const u = new URL(req.url!, 'https://github.com');
    const c = spawn('/usr/bin/git', ['http-backend'], { env: { ...f.env, GIT_PROJECT_ROOT: join(f.root, 'http-root'), GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'synthetic', REQUEST_METHOD: req.method!, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: String(req.headers['content-type'] ?? '') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; c.stdout.on('data', b => chunks.push(b)); c.stderr.resume(); req.pipe(c.stdin);
    c.once('close', code => { const b = Buffer.concat(chunks), at = b.indexOf('\r\n\r\n'); if (code !== 0 || at < 0) { res.writeHead(500); res.end(); return; } const headers: Record<string,string> = {}; let status = 200; for (const line of b.subarray(0,at).toString().split('\r\n')) { const i=line.indexOf(':'); if (i<0) continue; if (line.slice(0,i).toLowerCase()==='status') status=Number(line.slice(i+1).trim().split(' ')[0]); else headers[line.slice(0,i)]=line.slice(i+1).trim(); } res.writeHead(status,headers); res.end(b.subarray(at+4)); });
  });
  const proxy = createHttpServer(); for (const server of [https,proxy]) server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));}); https.listen(0,'127.0.0.1'); await once(https,'listening');
  proxy.on('connect',(req,socket,head)=>{if(req.url!=='github.com:443'){socket.destroy();return;}const up=connectTcp((https.address() as any).port,'127.0.0.1');sockets.add(up);up.on('error',()=>socket.destroy());socket.on('error',()=>up.destroy());up.on('close',()=>sockets.delete(up));up.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)up.write(head);socket.pipe(up);up.pipe(socket);});}); proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await Promise.all([https,proxy].map(s=>new Promise<void>(r=>s.close(()=>r()))));});
  await f.native('config','http.proxy',`http://127.0.0.1:${(proxy.address() as any).port}`);await f.native('config','http.sslVerify','false');f.managedEnv.NO_PROXY='';
  const marker=join(f.root,'machine-ssh-invoked'),ssh=join(f.root,'machine-ssh');await writeFile(ssh,'#!/bin/sh\nprintf called > "$SYNTHETIC_SSH_MARKER"\nexit 1\n',{mode:0o700});f.managedEnv.GIT_SSH_COMMAND=ssh;f.managedEnv.SYNTHETIC_SSH_MARKER=marker;
  await f.native('remote','add','origin','git@github.com:synthetic/repo.git');
  for(const [i,url] of ['git@github.com:synthetic/repo.git','ssh://git@github.com/synthetic/repo.git'].entries()){
    await f.native('remote','set-url','origin',url);const before=await readFile(join(f.work,'.git/config'),'utf8');
    const commit=await f.managed('commit','--allow-empty','-qm','employee SSH remote');assert.equal(commit.code,0,commit.err);const sha=(await f.native('rev-parse','HEAD')).out,branch=`vault-check-${i}`;
    const push=await f.managed('push','origin',`HEAD:refs/heads/${branch}`);assert.equal(push.code,0,push.err);
    assert.equal((await child('/usr/bin/git',['--git-dir',bare,'rev-parse',`refs/heads/${branch}`],f.env,f.root)).out,sha);
    const read=await f.managed('ls-remote','--heads',url,`refs/heads/${branch}`);assert.equal(read.code,0,read.err);assert.equal(read.out,`${sha}\trefs/heads/${branch}`);
    const remove=await f.managed('push','origin','--delete',branch);assert.equal(remove.code,0,remove.err);const missing=await f.managed('ls-remote','--heads','origin',`refs/heads/${branch}`);assert.equal(missing.code,0,missing.err);assert.equal(missing.out,'');
    assert.equal(await readFile(join(f.work,'.git/config'),'utf8'),before);
  }
  assert.ok(received.length>0&&received.every(v=>v===expected));assert.ok(f.credentials()>0);await assert.rejects(readFile(marker));
  const requestsBefore=received.length; f.managedEnv.OPENCRAFT_GIT_BROKER_SOCKET=join(f.root,'missing-broker.sock');const unavailable=await f.managed('push','origin','HEAD:refs/heads/no-fallback');assert.equal(unavailable.code,128);assert.match(unavailable.err,/broker unavailable/u);assert.equal(received.length,requestsBefore);await assert.rejects(readFile(marker));
});


test('explicit server-read policy preserves SSH transport and personal signed pull without enabling SSH push', async t => {
  const f = await managedRepository(t), signing = generateGitSigningKey();
  f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Employee', email: 'employee@example.test' }, token: 'synthetic-only', signing });
  const bare = join(f.root, 'server.git'), marker = join(f.root, 'ssh-reads'), ssh = join(f.root, 'ssh');
  assert.equal((await child('/usr/bin/git', ['init', '--bare', '-q', bare], f.env, f.root)).code, 0);
  assert.equal((await f.native('push', bare, 'HEAD:main')).code, 0);
  await child('/usr/bin/git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], f.env, f.root);
  await writeFile(ssh, `#!/bin/sh
set -eu
for last do :; done
case "$last" in
  "git-upload-pack "*)
    test "$SSH_AUTH_SOCK" = "$SYNTHETIC_MACHINE_SOCK"
    test "$HOME" = "$SYNTHETIC_MACHINE_HOME"
    printf 'read\\n' >> "$SYNTHETIC_SSH_MARKER"
    exec /usr/bin/git-upload-pack "$SYNTHETIC_BARE" ;;
  "git-receive-pack "*) printf 'write\\n' >> "$SYNTHETIC_SSH_MARKER"; exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  Object.assign(f.managedEnv, { OPENCRAFT_GIT_SERVER_READ_HOSTS: 'github.com', GIT_SSH_COMMAND: ssh,
    SSH_AUTH_SOCK: join(f.root, 'server-agent.sock'), SYNTHETIC_MACHINE_SOCK: join(f.root, 'server-agent.sock'),
    SYNTHETIC_MACHINE_HOME: f.managedEnv.HOME, SYNTHETIC_SSH_MARKER: marker, SYNTHETIC_BARE: bare });
  await f.native('remote', 'add', 'origin', 'git@github.com:synthetic/repo.git');
  const before = await readFile(join(f.work, '.git/config'));
  for (const url of ['git@github.com:synthetic/repo.git', 'ssh://git@github.com/synthetic/repo.git', 'https://github.com/synthetic/repo.git']) {
    const result = await f.managed('ls-remote', '--heads', url, 'refs/heads/main');
    assert.equal(result.code, 0, result.err); assert.match(result.out, /\trefs\/heads\/main$/u);
    const fetched = await f.managed('fetch', url, 'main'); assert.equal(fetched.code, 0, fetched.err);
  }
  const cloned = await f.managed('clone', 'https://github.com/synthetic/repo.git', join(f.root, 'clone'));
  assert.equal(cloned.code, 0, cloned.err);
  assert.equal((await child('/usr/bin/git', ['-C', join(f.root, 'clone'), 'config', '--get', 'remote.origin.url'], f.env, f.root)).out, 'https://github.com/synthetic/repo.git');
  const seed = join(f.root, 'seed');
  await child('/usr/bin/git', ['clone', '-q', bare, seed], f.env, f.root);
  await child('/usr/bin/git', ['commit', '--allow-empty', '-qm', 'remote advanced'], f.env, seed);
  await child('/usr/bin/git', ['push', '-q', 'origin', 'main'], f.env, seed);
  await f.native('commit', '--allow-empty', '-qm', 'local advanced');
  const pulled = await f.managed('pull', '--no-rebase', '--no-edit', 'origin', 'main'); assert.equal(pulled.code, 0, pulled.err);
  assert.equal((await f.native('show', '-s', '--format=%an|%ae|%cn|%ce')).out, 'Employee|employee@example.test|Employee|employee@example.test');
  assert.equal((await f.native('rev-list', '--parents', '-1', 'HEAD')).out.split(' ').length, 3);
  const allowed = join(f.root, 'allowed-signers'); await writeFile(allowed, `employee@example.test ${signing.publicKey}\n`);
  const verified = await f.native('-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', 'HEAD'); assert.equal(verified.code, 0, verified.err);
  assert.deepEqual(await readFile(join(f.work, '.git/config')), before);
  assert.equal(f.credentials(), 0, 'server reads do not request personal HTTP credentials');
  const readsBefore = await readFile(marker, 'utf8');
  for (const args of [
    ['clone', '--recurse-submodules', 'https://github.com/synthetic/repo.git', join(f.root, 'recursive-clone')],
    ['fetch', '--recurse-submodules=on-demand', 'origin'],
    ['pull', '--recurse-submodules', 'origin', 'main'],
    ['clone', '--config', 'submodule.recurse=true', 'https://github.com/synthetic/repo.git', join(f.root, 'recursive-config-clone')],
  ]) {
    const recursive = await f.managed(...args); assert.equal(recursive.code, 128); assert.match(recursive.err, /recursive|conflicting command/u);
  }
  for (const key of ['submodule.recurse', 'fetch.recurseSubmodules']) {
    await f.native('config', key, 'true');
    const recursive = await f.managed('fetch', 'origin'); assert.equal(recursive.code, 128); assert.match(recursive.err, /recursive Git configuration/u);
    await f.native('config', '--unset', key);
  }
  await f.native('config', 'url.https://github.com/.insteadOf', 'work:');
  const alias = await f.managed('ls-remote', 'work:synthetic/repo.git'); assert.equal(alias.code, 128); assert.match(alias.err, /canonical remote without URL rewrites/u);
  await f.native('config', '--unset', 'url.https://github.com/.insteadOf');
  assert.equal(await readFile(marker, 'utf8'), readsBefore, 'recursive and rewritten URLs are refused before server SSH');
  await f.native('config', 'http.proxy', 'http://127.0.0.1:9');
  const pushed = await f.managed('push', 'origin', 'HEAD:refs/heads/no-server-push'); assert.notEqual(pushed.code, 0);
  assert.equal(await readFile(marker, 'utf8'), readsBefore, 'push never invokes server SSH');
  assert.notEqual((await child('/usr/bin/git', ['--git-dir', bare, 'show-ref', '--verify', 'refs/heads/no-server-push'], f.env, f.root)).code, 0);
  f.setIdentity({ status: 'active', account: 'synthetic:unbound', executionId: 'other-turn' });
  const unbound = await f.managed('ls-remote', '--heads', 'origin'); assert.equal(unbound.code, 0, unbound.err);
  f.setIdentity({ status: 'unknown' });
  const unknown = await f.managed('ls-remote', '--heads', 'origin'); assert.equal(unknown.code, 128); assert.match(unknown.err, /broker unavailable/u);
});

test('installation launcher restores its broker connection when callers filter inherited environment', async t => {
  const f = await managedRepository(t);
  f.bind();
  await f.native('remote', 'add', 'origin', 'https://github.com/synthetic/repo.git');
  await writeFile(join(f.root, 'git-identity-wrapper.mjs'), await readFile(join(f.root, 'git.mjs')));
  const prepared = renderGitIdentityInstallation({ installationDirectory: f.root, runtimeDirectory: f.root,
    node: process.execPath, nativeGit: '/usr/bin/git', brokerSocket: f.socket,
    hosts: ['github.com'], basePath: '/usr/bin:/bin' });
  const launcher = join(f.root, 'installed-git');
  await writeFile(launcher, prepared.launcher, { mode: 0o700 });
  for (const removed of [['OPENCRAFT_GIT_BROKER_SOCKET'], Object.keys(f.managedEnv).filter(key => key.startsWith('OPENCRAFT_GIT_'))]) {
    const env = { ...f.managedEnv };
    for (const key of removed) delete env[key];
    const result = await child(launcher, ['commit', '--allow-empty', '-m', 'through installed broker'], env, f.work);
    assert.equal(result.code, 0, result.err);
    assert.equal((await f.native('log', '-1', '--format=%an <%ae>')).out, 'Employee <employee@example.test>');
  }
  assert.ok(f.opens.includes('github.com'), 'the real wrapper must contact the installed broker');
});

test('installation launcher applies an explicit read policy to already-running callers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-read-policy-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'git-identity-wrapper.mjs'), 'process.stdout.write(JSON.stringify(process.env.OPENCRAFT_GIT_SERVER_READ_HOSTS));');
  const spec = { installationDirectory: root, runtimeDirectory: root, node: process.execPath, nativeGit: '/usr/bin/git', brokerSocket: join(root, 'broker.sock'), hosts: ['github.com'], basePath: '/usr/bin:/bin' };
  for (const [policy, expected] of [[undefined, 'inherited.example.test'], [[], ''], [['github.com'], 'github.com']] as const) {
    const prepared = renderGitIdentityInstallation({ ...spec, serverReadHosts: policy });
    const launcher = join(root, 'git'); await writeFile(launcher, prepared.launcher, { mode: 0o700 });
    const result = await child(launcher, [], { ...process.env, OPENCRAFT_GIT_SERVER_READ_HOSTS: 'inherited.example.test' }, root);
    assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out), expected);
    assert.equal(prepared.environment.OPENCRAFT_GIT_SERVER_READ_HOSTS, policy?.join(','));
  }
  for (const host of ['other.example.test', 'github.com\n', 'github.com,evil.test']) assert.throws(() => renderGitIdentityInstallation({ ...spec, serverReadHosts: [host] }));
});

test('personal SSH push uses the employee memory agent, rewrites HTTPS, never machine keys or tokens', async t => {
  const f = await managedRepository(t);
  f.managedEnv.OPENCRAFT_GIT_HOSTS = 'git.example.test';
  f.managedEnv.OPENCRAFT_GIT_SERVER_READ_HOSTS = 'git.example.test';
  f.managedEnv.OPENCRAFT_GIT_PERSONAL_SSH_PUSH_HOSTS = 'git.example.test';
  const sshAuth = generateGitSigningKey(), otherKey = generateGitSigningKey();
  const binding = { identity: { username: 'synthetic', name: 'Employee', email: 'employee@example.test' }, token: '', signing: null, sshAuth };
  f.store.write('synthetic:1', 'git.example.test', 0, { ...binding, token: 'synthetic-unused', sshAuth: null });
  const missing = await f.managed('push', 'https://git.example.test/synthetic/repo.git', 'HEAD:missing');
  assert.equal(missing.code, 128); assert.match(missing.err, /generate a personal SSH key/u);
  assert.equal(f.credentials(), 0);
  f.store.write('synthetic:1', 'git.example.test', 1, binding);
  f.store.write('synthetic:2', 'git.example.test', 0, { ...binding, sshAuth: otherKey });
  const bare = join(f.root, 'server.git');
  await child('/usr/bin/git', ['init', '--bare', '-q', bare], f.env, f.root);
  // Only a synthetic server host key is written by the fixture; employee keys stay in the broker.
  const hostKey = join(f.root, 'synthetic-server-host');
  const generated = await child('/usr/bin/ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-f', hostKey], f.env, f.root);
  assert.equal(generated.code, 0, generated.err);
  let expectedPublic = sshAuth.publicKey, authenticated = 0, executions = 0;
  const connections = new Set<any>();
  const server = new SshServer({ hostKeys: [await readFile(hostKey)] }, connection => {
    connections.add(connection); connection.on('close', () => connections.delete(connection)); connection.on('error', () => {});
    connection.on('authentication', ctx => {
      const publicBlob = Buffer.from(expectedPublic.split(' ')[1]!, 'base64');
      if (ctx.method !== 'publickey' || ctx.username !== 'git' || !ctx.key.data.equals(publicBlob)) { ctx.reject(); return; }
      if (!ctx.signature) { ctx.accept(); return; }
      const key = sshUtils.parseKey(expectedPublic);
      if (key instanceof Error || key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) { ctx.reject(); return; }
      authenticated++; ctx.accept();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept(); session.on('exec', (accept, reject, info) => {
        if (info.command !== "git-receive-pack 'synthetic/repo.git'") { reject(); return; }
        executions++; const stream = accept();
        const backend = spawn('/usr/bin/git-receive-pack', [bare], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
        stream.pipe(backend.stdin); backend.stdout.pipe(stream, { end: false }); backend.stderr.pipe(stream.stderr, { end: false });
        backend.on('close', code => { stream.exit(code ?? 1); stream.end(); });
        stream.on('close', () => backend.kill());
      });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const connection of connections) connection.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port;
  const home = join(f.root, 'home'); await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh/known_hosts'), `git.example.test,[git.example.test]:${port} ${(await readFile(hostKey + '.pub', 'utf8')).trim()}\n`);
  f.managedEnv.HOME = home;
  // A native fixture redirects only the SSH destination to loopback. The actual
  // wrapper, OpenSSH authentication, memory agent and Git receive-pack all run.
  const native = join(f.root, 'native.cjs');
  await writeFile(native, `const {spawnSync}=require('node:child_process');const env={...process.env};
if(env.GIT_SSH_COMMAND?.includes('IdentityAgent='))env.GIT_SSH_COMMAND+=' -o HostName=127.0.0.1 -o HostKeyAlias=git.example.test -p '+env.SYNTHETIC_SSH_PORT;
const r=spawnSync('/usr/bin/git',process.argv.slice(2),{env,stdio:'inherit'});process.exit(r.status??1);`);
  const launcher = join(f.root, 'native'); await writeFile(launcher, `#!/bin/sh\nexec '${process.execPath}' '${native}' "$@"\n`, { mode: 0o700 });
  f.managedEnv.OPENCRAFT_GIT_NATIVE = launcher; f.managedEnv.SYNTHETIC_SSH_PORT = String(port);
  await f.native('remote', 'add', 'origin', 'https://git.example.test/synthetic/repo.git');
  const before = await readFile(join(f.work, '.git/config'), 'utf8');
  for (const url of ['https://git.example.test/synthetic/repo.git', 'git@git.example.test:synthetic/repo.git', 'ssh://git@git.example.test/synthetic/repo.git']) {
    const push = await f.managed('push', url, 'HEAD:main'); assert.equal(push.code, 0, push.err);
  }
  assert.equal((await child('/usr/bin/git', ['--git-dir', bare, 'rev-parse', 'main'], f.env, f.root)).out, (await f.native('rev-parse', 'HEAD')).out);
  assert.equal(await readFile(join(f.work, '.git/config'), 'utf8'), before); assert.equal(f.credentials(), 0);
  f.setIdentity({ status: 'active', account: 'synthetic:2', executionId: 'turn2' });
  const wrong = await f.managed('push', 'origin', 'HEAD:wrong'); assert.notEqual(wrong.code, 0, 'second employee cannot sign with first employee key');
  expectedPublic = otherKey.publicKey;
  assert.equal((await f.managed('push', 'origin', 'HEAD:other')).code, 0);
  f.setIdentity({ status: 'active', account: 'synthetic:unbound', executionId: 'turn3' });
  // Unbound employee uses the original native Git and original local file transport.
  assert.equal((await f.managed('push', bare, 'HEAD:unbound')).code, 0);
  assert.equal(f.credentials(), 0);
  assert.equal(authenticated, 4); assert.equal(executions, 4, 'failed push was neither replayed nor sent through machine SSH');
  for (const name of await readdir(f.root, { recursive: true })) {
    const path = join(f.root, name); if (!(await stat(path)).isFile()) continue;
    const bytes = await readFile(path);
    for (const privateKey of [sshAuth.privateKey, otherKey.privateKey]) assert.equal(bytes.includes(Buffer.from(privateKey)), false);
  }
});


test('HTTPS credential allowlist denies a retired token without changing other hosts', async t => {
  const f = await fixture(t, ['github.com']);
  for (const host of ['git.example.test', 'github.com']) {
    f.store.write('synthetic:1', host, 0, { identity: { username: 'synthetic', name: 'Synthetic', email: 'synthetic@example.test' }, token: 'synthetic-retired-token', signing: null });
    const session = await queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'synthetic-thread', host });
    assert.equal(session.status, 'configured');
    const answer = await queryGitIdentityBroker(f.socket, { op: 'credential', sessionId: session.sessionId, host, protocol: 'https' });
    assert.equal(answer.status, host === 'github.com' ? 'configured' : 'denied');
    if (host !== 'github.com') assert.equal(JSON.stringify(answer).includes('synthetic-retired-token'), false);
  }
});

test('broker fence includes pending admission, drains existing signer, and cold successor preserves history', async t => {
  const f = await fixture(t);
  f.store.write('synthetic:1', 'github.com', 0, { identity: { username: 'synthetic', name: 'Synthetic', email: 'synthetic@example.test' }, token: 'synthetic-only', signing: generateGitSigningKey() });
  const session = await queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'synthetic-thread', host: 'github.com' });
  const call = (input: any) => queryGitIdentityBroker(f.socket, { op: 'owner-handoff', ...input });
  const initial = (await call({ action: 'snapshot' })).handoff;
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const claim = { version: 1, id: 'broker-test-lease', ttlMs: 15000, controller: { pid: process.pid, startTime: stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19], bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() } };
  const input = { expectedOwner: initial.owner, expectedEpoch: initial.epoch, operationId: 'broker-test', fence: 'broker-test-fence', operatorLease: claim };
  const fenced = await call({ action: 'fence', ...input }); assert.equal(fenced.handoff.phase, 'fenced');
  input.expectedEpoch++;
  assert.equal((await queryGitIdentityBroker(f.socket, { op: 'open', threadId: 'synthetic-thread', host: 'github.com' })).status, 'unavailable');
  assert.equal((await call({ action: 'release', ...input })).status, 'conflict');
  assert.ok((await call({ action: 'snapshot' })).handoff.pending.some((r: any) => r.kind === 'command-session'));
  assert.equal((await queryGitIdentityBroker(f.socket, { op: 'close', sessionId: session.sessionId })).status, 'closed');
  assert.equal((await call({ action: 'release', ...input })).handoff.phase, 'released');
  assert.equal((await call({ action: 'cold-ready', ...input })).handoff.phase, 'cold-ready');
  assert.equal((await call({ action: 'resume', ...input })).handoff.phase, 'open');
});
test('durable broker restart refuses unconfirmed signing and never forgets unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'broker-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'owner.json'), owner = new GitBrokerOwner(path);
  const finish = owner.begin('sign');
  assert.throws(() => new GitBrokerOwner(path), /recovery required/);
  finish(true);
  const successor = new GitBrokerOwner(path);
  assert.equal(successor.snapshot().history.length, 1);
  assert.equal((successor.snapshot().history[0] as any).outcome, 'unknown');
});
