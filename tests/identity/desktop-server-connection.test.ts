import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDesktopServer, ServerAccessDenied, ServerSignInRequired } from '../../apps/workbench-electron/src/desktop-server-admission';
import { configureDesktopServer } from '../../apps/workbench-web/src/runtime/configure-desktop-server';
import { parseDesktopServerConnection, isDesktopServerConnectMessage } from '@opencraft/app-host-protocol/desktop-server';
import type { HostConnectionProfile, ProvisionHostInput } from '@opencraft/workbench-runtime';

const origin = 'https://server.example';
const ingress = () => Response.json({ error: 'WebSocket upgrade required' }, { status: 426 });

test('desktop admission uses the execution contract without requiring a particular identity plugin', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const read = async (url: string, init?: RequestInit) => { calls.push([url, init]); return ingress(); };
  assert.equal(await verifyDesktopServer(origin, read), origin);
  assert.deepEqual(calls.map(([url]) => url), [origin + '/appserver']);
  for (const [, init] of calls) { assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'manual'); assert.deepEqual(init?.headers, { origin, accept: 'application/json' }); }
  // Native connection scopes are opaque; renderer recipes cannot inject endpoints or credentials.
  const connection = { origin, accountKey: 'a'.repeat(64) };
  assert.deepEqual(parseDesktopServerConnection(connection), connection);
  assert(!isDesktopServerConnectMessage({ type: 'opencraft:connect-desktop-server', origin: 'file:///etc', accountKey: connection.accountKey }));
});

test('redirects, denied access, HTML and unavailable execution protocols cannot commit a connection', async () => {
  for (const status of [301, 302, 303, 307, 401]) await assert.rejects(verifyDesktopServer(origin, async () => new Response('', { status })), ServerSignInRequired);
  await assert.rejects(verifyDesktopServer(origin, async () => new Response('', { status: 403 })), ServerAccessDenied);
  for (const result of [new Response('<html>Workbench</html>'), Response.json({ error: 'different protocol' }, { status: 426 }), new Response('', {status:503})]) await assert.rejects(verifyDesktopServer(origin, async () => result));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(verifyDesktopServer(origin, async () => ingress(), abort.signal));
});

test('closing configuration cancels native sign-in and late login cannot save a Host', async () => {
  let finish!: (value: { origin: string; accountKey: string }) => void;
  const controller = new AbortController();
  const cancelled: string[] = [], provisioned: unknown[] = [];
  const operation = configureDesktopServer({ origin, signal: controller.signal, profiles: [],
    port: { prepare: () => new Promise(resolve => { finish = resolve; }), cancel: async id => { cancelled.push(id); }, validate: async () => null, onRevoked: () => () => {} },
    provision: async value => { provisioned.push(value); return value as unknown as HostConnectionProfile; } });
  controller.abort(); finish({ origin, accountKey: 'a'.repeat(64) });
  await assert.rejects(operation); assert.equal(cancelled.length, 1); assert.deepEqual(provisioned, []);
});

test('successful configuration saves only public scoped routing and passes its cancellation to preflight', async () => {
  const controller = new AbortController();
  const calls: Array<{ value: ProvisionHostInput; signal?: AbortSignal }> = [];
  const connection = { origin, accountKey: 'b'.repeat(64) };
  const result = await configureDesktopServer({ origin, signal: controller.signal, profiles: [],
    port: { prepare: async () => connection, cancel: async () => {}, validate: async () => null, onRevoked: () => () => {} },
    provision: async (value, options) => { calls.push({ value, signal: options?.signal }); return value as HostConnectionProfile; } });
  assert.equal(calls.length, 1); assert.equal(calls[0]!.signal, controller.signal);
  assert.equal(result.providerId, 'opencraft.desktop-server');
  assert.equal(result.hostId, 'desktop-server:' + connection.accountKey);
  assert.deepEqual(result.providerConfig, connection);
  assert.equal(result.hostKind, 'remote-control');
});

test('closing the native sign-in surface is cancellation, never a saved connection', async () => {
  let writes = 0;
  await assert.rejects(configureDesktopServer({ origin, signal: new AbortController().signal, profiles: [],
    port: { prepare: async () => null, cancel: async () => {}, validate: async () => null, onRevoked: () => () => {} },
    provision: async () => { writes++; throw new Error('Must not save'); } }), { name: 'AbortError' });
  assert.equal(writes, 0);
});
