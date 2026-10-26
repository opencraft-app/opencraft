import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopAccountHost } from '../../plugins/local-account/src/desktop';
import { createWorkbenchStaticServer } from '../../scripts/serve-workbench-static.mjs';
import { MembershipStore } from '../../packages/access-control/src/index';
import { startOpenCraftDaemonServer } from '../../apps/opencraft-daemon/src/server';
import { AppHostServer } from '@opencraft/app-host-server';
import { connect } from 'node:net';
import { DaemonJsonLineChannel, OPENCRAFT_DAEMON_BUILD_ID, OPENCRAFT_DAEMON_PROTOCOL_VERSION } from '@opencraft/daemon-ipc';
import { humanLoginPage } from '../../scripts/human-login-page';

test('real desktop static entry uses Main-held HttpOnly proof, shares one Human with the daemon and retires revoked sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-account-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<title>Desktop</title>');
  const opened: string[] = [];
  const host = await createDesktopAccountHost(join(root, 'account'), humanLoginPage, { async openRemote(origin) { opened.push(origin); } });
  const web = await createWorkbenchStaticServer({ root, accountService: host });
  const address = await web.listen({ host: '127.0.0.1', port: 0 }), origin = `http://127.0.0.1:${address.port}`;
  host.setOrigin(origin); t.after(async () => { await web.close(); host.close(); });
  const proof = `oc_desktop_owner=${host.browserProof}; oc_human=${host.browserSessionToken}`;
  const state = await (await fetch(origin + '/__opencraft_account/status', { headers: { cookie: proof } })).json() as any;
  assert.equal(state.administrator, true); assert.equal(state.desktopOwner, true); assert.equal(state.native, true);
  const anonymous = await (await fetch(origin + '/__opencraft_account/status')).json() as any;
  assert.equal(anonymous.actor, null); assert.equal(anonymous.native, false);
  assert.equal((await fetch(origin + '/__opencraft_account/native', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const daemonAuthority = await createDesktopAccountHost(join(root, 'account'), () => ''); t.after(() => daemonAuthority.close());
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
  const memberships = new MembershipStore(join(root, 'account', 'memberships.sqlite'));
  memberships.setActor(state.actor.id, 'admin', false, 'test-revocation'); memberships.close();
  assert.throws(() => context?.resourceOwner?.assertCurrent(), /revoked/);
  assert.equal(daemonAuthority.authenticateSession(host.createNativeSession()), null);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Revoked native connection survived')), 2000); timer.unref(); })]);
});
