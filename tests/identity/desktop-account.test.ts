import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopAccountHost } from '../../plugins/local-account/src/desktop';
import { createWorkbenchStaticServer } from '../../apps/headless-server/src/serve-workbench-static.mjs';
import { MembershipStore } from '../../packages/access-control/src/index';
import { startOpenCraftDaemonServer } from '../../apps/opencraft-daemon/src/server';
import { AppHostServer } from '@opencraft/app-host-server';
import { connect } from 'node:net';
import { DaemonJsonLineChannel, OPENCRAFT_DAEMON_BUILD_ID, OPENCRAFT_DAEMON_PROTOCOL_VERSION } from '@opencraft/daemon-ipc';
import { humanLoginPage } from '../../apps/headless-server/src/human-login-page';
import { scryptSync } from 'node:crypto';
import { storedPasswordShape } from '../../plugins/local-account/src/password-hash';
import { createPortablePasswordHasher } from '../../plugins/local-account/src/password-hash-portable';

test('real desktop static entry uses Main-held HttpOnly proof, shares one Human with the daemon and retires revoked sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-account-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<title>Desktop</title>');
  const opened: string[] = [];
  const host = await createDesktopAccountHost(join(root, 'account'), humanLoginPage, { async openRemote(origin) { opened.push(origin); } });
  const web = await createWorkbenchStaticServer({ root, accountService: host });
  const address = await web.listen({ host: '127.0.0.1', port: 0 }), origin = `http://127.0.0.1:${address.port}`;
  host.setOrigin(origin); t.after(async () => { await web.close(); await host.close(); });
  const proof = `oc_desktop_owner=${host.browserProof}; oc_human=${host.browserSessionToken}`;
  const state = await (await fetch(origin + '/__opencraft_account/status', { headers: { cookie: proof } })).json() as any;
  assert.equal(state.administrator, true); assert.equal(state.desktopOwner, true); assert.equal(state.native, true);
  const anonymous = await (await fetch(origin + '/__opencraft_account/status')).json() as any;
  assert.equal(anonymous.actor, null); assert.equal(anonymous.native, false);
  assert.equal((await fetch(origin + '/__opencraft_account/native', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const daemonAuthority = await createDesktopAccountHost(join(root, 'account'), () => '', {storageRole:'borrower'}); t.after(() => daemonAuthority.close());
  const context = daemonAuthority.authenticateSession(host.createNativeSession());
  assert.equal(context?.actorContext?.actorId, state.actor.id); context?.resourceOwner?.assertCurrent();
  assert.equal(daemonAuthority.authenticateSession('arbitrary-renderer-actor'), null);
  assert.equal(host.createNativeSession(), host.createNativeSession(), 'native reconnect does not churn browser logins');
  const post = (body: unknown, cookie = proof) => fetch(origin + '/__opencraft_account/connect', { method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ origin: 'https://remote.example' }, '')).status, 403);
  assert.equal((await post({ origin: 'http://192.168.1.1' })).status, 400);
  assert.equal((await post({ origin: 'https://user:password@remote.example' })).status, 400);
  assert.equal((await post({ origin: 'https://remote.example' })).status, 200);
  assert.deepEqual(opened, ['https://remote.example']);
  const appHost = new AppHostServer({ createTransport() { throw new Error('No execution required'); } });
  const daemon = await startOpenCraftDaemonServer({ endpoint: join(root, 'daemon.sock'), authToken: 'private-daemon-token-for-synthetic-test',
    appHost, onShutdownRequested() {}, authenticateHumanSession: token => daemonAuthority.authenticateSession(token) });
  t.after(async () => { await daemon.close(); await appHost.close(); });
  const handshake = async (humanSession?: string) => {
    const socket = connect(daemon.endpoint), channel = new DaemonJsonLineChannel(socket);
    const frame = new Promise<any>((resolve, reject) => { channel.subscribeMessage(resolve); channel.subscribeClose(error => reject(error)); });
    socket.once('connect', () => channel.send({ type: 'daemon/hello', protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION,
      buildId: OPENCRAFT_DAEMON_BUILD_ID, authToken: 'private-daemon-token-for-synthetic-test', role: 'app-host', connectionId: 'test-native', humanSession }));
    return { channel, ready: await frame };
  };
  const anonymousDaemon = await handshake(); assert.equal(anonymousDaemon.ready.type, 'daemon/fatal'); anonymousDaemon.channel.close();
  const trusted = await handshake(host.createNativeSession()); assert.equal(trusted.ready.type, 'daemon/ready');
  const closed = new Promise<void>(resolve => trusted.channel.subscribeClose(() => resolve()));
  const memberships = new MembershipStore(host.storage);
  memberships.setActor(state.actor.id, 'admin', false, 'test-revocation'); memberships.close();
  assert.throws(() => context?.resourceOwner?.assertCurrent(), /revoked/);
  assert.equal(daemonAuthority.authenticateSession(host.createNativeSession()), null);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Revoked native connection survived')), 2000); timer.unref(); })]);
});

test('desktop local passwords: new records are Argon2id, scrypt upgrades through the owner Worker by compare-and-set, Headless records interoperate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-password-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<title>Desktop</title>');
  const host = await createDesktopAccountHost(join(root, 'account'), humanLoginPage);
  const web = await createWorkbenchStaticServer({ root, accountService: host });
  const address = await web.listen({ host: '127.0.0.1', port: 0 }), origin = `http://127.0.0.1:${address.port}`;
  host.setOrigin(origin); t.after(async () => { await web.close(); await host.close(); });
  const auth = (path: string, body: unknown, cookie = '') => fetch(origin + '/__opencraft_auth' + path, { method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const db = host.storage.database;
  const record = () => ({ ...db.prepare('SELECT id,salt,password_digest AS passwordDigest,version,enabled FROM local_accounts WHERE username=?').get('desk-user') }) as
    { id: string; salt: string; passwordDigest: string; version: number; enabled: number };
  const password = 'desktop-password-long';
  const owner = `oc_desktop_owner=${host.browserProof}; oc_human=${host.browserSessionToken}`;
  assert.equal((await auth('/local/create', { mode: 'link', username: 'desk-user', password }, owner)).status, 200);
  const created = record();
  assert.equal(storedPasswordShape(created), 'argon2id', 'desktop writes Argon2id');
  assert.match(created.passwordDigest, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
  // Headless on workerd (portable hasher) reads the desktop record without a rehash.
  assert.deepEqual(await createPortablePasswordHasher().verify(password, created), { ok: true, needsRehash: false });

  // A pre-Argon2id record: a wrong password never rewrites it, the right one upgrades it in place.
  const salt = 'f'.repeat(64);
  const scrypt = scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex');
  db.prepare('UPDATE local_accounts SET salt=?, password_digest=? WHERE id=?').run(salt, scrypt, created.id);
  assert.equal((await auth('/local', { mode: 'login', username: 'desk-user', password: password + '-wrong' })).status, 401);
  assert.deepEqual(record(), { ...created, salt, passwordDigest: scrypt }, 'wrong password keeps the scrypt record');
  assert.equal((await auth('/local', { mode: 'login', username: 'desk-user', password })).status, 200);
  const upgraded = record();
  assert.equal(storedPasswordShape(upgraded), 'argon2id');
  assert.equal(upgraded.salt, '');
  assert.equal(upgraded.version, created.version, 'an upgrade is not a password change');
  assert.equal((await auth('/local', { mode: 'login', username: 'desk-user', password })).status, 200, 'the upgraded record still logs in');
  assert.deepEqual(record(), upgraded, 'a current Argon2id record is not rewritten');

  // The owner commits only while the verified record and version are current.
  const call = (host.storage as unknown as { call: { upgradeLocalPassword(id: string, expected: unknown, salt: string, digest: string): Promise<boolean> } }).call;
  const replacement = await createPortablePasswordHasher().hash(password);
  assert.equal(await call.upgradeLocalPassword(upgraded.id, { version: upgraded.version, salt, passwordDigest: scrypt }, '', replacement), false, 'stale record');
  assert.equal(await call.upgradeLocalPassword(upgraded.id, { version: upgraded.version + 1, salt: '', passwordDigest: upgraded.passwordDigest }, '', replacement), false, 'stale version');
  assert.deepEqual(record(), upgraded, 'a refused compare-and-set leaves the record');

  // A record a Headless (workerd) installation wrote verifies on desktop unchanged.
  db.prepare('UPDATE local_accounts SET salt=?, password_digest=? WHERE id=?').run('', replacement, upgraded.id);
  assert.equal((await auth('/local', { mode: 'login', username: 'desk-user', password })).status, 200);
  assert.equal(record().passwordDigest, replacement);
});
