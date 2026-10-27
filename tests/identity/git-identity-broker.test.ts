import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import nodeTest from 'node:test';
import { build } from 'esbuild';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store';
import { GitIdentityBroker, type GitExecutionIdentity } from '../../scripts/git-identity-broker';
import { queryGitIdentityBroker, serveGitIdentityBroker } from '../../scripts/git-identity-ipc';
import { exactGitHost, gitConfigParameter, parseGitInvocation, personalHttpsRemote } from '../../scripts/git-identity-wrapper';
import { managedGitEnvironment } from '../../scripts/git-identity-environment';
import { generateGitSigningKey } from '../../scripts/git-identity-signer';
// SO_PEERCRED and /proc are the supported local Linux execution boundary.
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'git-broker-test-'));
  const store = new EmployeeGitVaultStore(root); let identity: GitExecutionIdentity = { status: 'active', account: 'synthetic:1', executionId: 'turn1' };
  const broker = new GitIdentityBroker({ store, hosts: ['github.com', 'unconfigured.example.test'], runtimeDirectory: root, resolve: async () => identity });
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
