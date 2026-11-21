import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ServerInformationStore, serverInformationHttp, normalizePublicEntry, SERVER_INFORMATION_PATH } from '../../apps/headless-server/src/server-information.mjs';
import { isHeadlessBackendPath } from '../../scripts/web-deployment/headless-backend.mjs';
import { PushStore, TurnPushService, type PushBinding } from '@opencraft/web-push-node';
const binding: PushBinding = { context: { actorId: 'admin-a', credentialId: null, generation: 1, expiresAt: Date.now() + 86400000 } };
const messages = { completed: 'Done', failed: 'Failed', interrupted: 'Stopped', body: 'Return to conversation', test: 'Test' };
async function fixture(t: test.TestContext) { const root = await mkdtemp(join(tmpdir(), 'server-information-')); t.after(() => rm(root, { recursive: true, force: true })); return { root, path: join(root, 'server-information.json') }; }

test('public entries are explicit, credential-free HTTP(S) URLs with exact Hub path prefixes', () => {
  assert.equal(normalizePublicEntry(' https://Example.COM/servers/hub-id/ '), 'https://example.com/servers/hub-id');
  assert.equal(normalizePublicEntry('http://127.0.0.1:12000'), 'http://127.0.0.1:12000');
  assert.equal(normalizePublicEntry('https://join.example/servers/hub-id/local'), 'https://join.example/servers/hub-id/local');
  assert.equal(normalizePublicEntry(''), '');
  for (const value of ['join.example', '//evil.test', 'javascript:alert(1)', 'file:///tmp/a', 'https://u:p@example.com', 'https://e/a?token=x', 'https://e/a#x', 'https://e/a/../b', 'https://e/a//b', 'https://e/%2f%2fevil', 'https://e/a\\b', 'https://e/a b', null]) assert.throws(() => normalizePublicEntry(value), /invalid_public_url/);
});
test('configuration survives owner/image replacement, uses private atomic files and optimistic revision fences', async t => {
  const f = await fixture(t), a = new ServerInformationStore(f.path), b = new ServerInformationStore(f.path);
  assert.deepEqual(await a.read(), { revision: 0, publicUrl: '' });
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  const results = await Promise.allSettled([a.write(0, 'https://one.example/servers/one', 'admin-a', () => {}), b.write(0, 'https://two.example', 'admin-b', () => {})]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /revision_conflict/);
  const saved = await a.read(); assert.equal(saved.revision, 1); assert.deepEqual(await new ServerInformationStore(f.path).read(), saved); assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(b.write(1, 'https://bad.example', 'admin-b', () => { throw Error('account_changed'); }), /account_changed/); assert.deepEqual(await a.read(), saved);
  assert.deepEqual(await b.write(1, '', 'admin-b', () => {}), { revision: 2, publicUrl: '' });
});
test('corrupt/unsupported configuration is visible as unavailable, never overwritten or silently treated as unconfigured', async t => {
  const f = await fixture(t); await writeFile(f.path, '{ broken'); const store = new ServerInformationStore(f.path);
  await assert.rejects(store.read(), /server_information_unavailable/); await assert.rejects(store.write(0, 'https://new.example', 'admin', () => {}), /server_information_unavailable/); assert.equal(await readFile(f.path, 'utf8'), '{ broken');
});
test('HTTP settings preserve human/admin authority, same-origin writes, account/revision fencing and no-store reads', async t => {
  const f = await fixture(t), store = new ServerInformationStore(f.path); let authority: any = null;
  const handle = serverInformationHttp(store, () => authority), server = createServer((req, res) => void handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + (server.address() as any).port + SERVER_INFORMATION_PATH;
  const post = (body: any, headers: any = {}) => fetch(url, { method: 'POST', headers: { origin: 'https://public.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  authority = { actorId: 'member', administrator: false, origin: 'https://public.example' };
  let response = await fetch(url); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal((await response.json()).canManage, false);
  const input = { expectedActorId: 'admin', revision: 0, publicUrl: 'https://entry.example/servers/server' };
  assert.equal((await post(input)).status, 403);
  authority = { actorId: 'admin', administrator: true, origin: 'https://public.example' };
  assert.equal((await post(input, { origin: 'https://other.example' })).status, 403);
  assert.equal((await post(input, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(input, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post({ ...input, expectedActorId: 'previous-account' })).status, 409);
  assert.equal((await post({ ...input, publicUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post({ ...input, extra: 'ignored?' })).status, 400);
  assert.equal((await post(input)).status, 200); assert.equal((await post(input)).status, 409);
  response = await fetch(url); assert.equal((await response.json()).publicUrl, input.publicUrl);
  assert.equal(isHeadlessBackendPath(SERVER_INFORMATION_PATH), true, 'standard Web proxy forwards the settings API to Headless');
  authority = null; assert.equal((await fetch(url)).status, 401);
});
test('revocation after asynchronous settings read cannot disclose authenticated information', async t => {
  const f = await fixture(t); let authority: any = { actorId: 'admin', administrator: true, origin: 'https://public.example' };
  const store = new ServerInformationStore(f.path), read = store.read.bind(store); store.read = async () => { const value = await read(); authority = null; return value; };
  const handle = serverInformationHttp(store, () => authority), server = createServer((req, res) => void handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }));
  const response = await fetch('http://127.0.0.1:' + (server.address() as any).port + SERVER_INFORMATION_PATH); assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'account_changed' });
});
test('existing external destinations use the current canonical entry without re-enrollment; pending turns retain host/thread identity', async t => {
  const f = await fixture(t), info = new ServerInformationStore(f.path), store = new PushStore(join(f.root, 'push.sqlite')), sent: any[] = [];
  const target = { kind: 'im' as const, channelId: 'verified.channel', senderId: 'verified-user', label: 'WeCom' };
  store.saveTarget(binding, target, 'http://obsolete.internal', '/servers/old-hub', 'en-US', messages);
  const service = new TurnPushService(store, { authenticate: () => binding, current: () => true, trustedOrigin: () => null, hosts: ['local-codex'], publicBaseUrl: async () => (await info.read()).publicUrl, read: async () => ({ thread: { id: 'thread', name: 'Subject' } }), sendIm: async (_binding, _target, message) => { sent.push(message); } }); t.after(() => service.close());
  const finish = async (id: string) => { store.watch('admin-a', 'native-server', 'local-codex', 'thread', id); store.finish(store.watches().find(w => w.inputId === id)!, id + '-turn', 'completed'); await service.tick(); };
  await finish('before'); assert.equal(sent[0].url, 'http://obsolete.internal/servers/old-hub/local/thread?hostId=local-codex');
  await info.write(0, 'https://entry.example/servers/new-hub', 'admin-a', () => {});
  await finish('after'); assert.equal(sent[1].url, 'https://entry.example/servers/new-hub/local/thread?hostId=local-codex'); assert.equal(sent[1].threadId, 'thread'); assert.equal(sent[1].hostId, 'local-codex'); assert.equal(store.devices('admin-a').length, 1, 'no duplicated/rebound destination');
  await info.write(1, 'https://independent.example', 'admin-a', () => {}); await finish('independent'); assert.equal(sent[2].url, 'https://independent.example/local/thread?hostId=local-codex');
});
test('browser push retains its subscribed application origin even with an external canonical entry', async t => {
  const f = await fixture(t), store = new PushStore(join(f.root, 'push.sqlite')), sent: any[] = [];
  store.register(binding, { endpoint: 'https://web.push.apple.com/example', keys: { p256dh: 'fixture', auth: 'fixture' } }, 'https://installed-app.example', '/servers/app', 'en-US', messages);
  const service = new TurnPushService(store, { authenticate: () => binding, current: () => true, trustedOrigin: () => null, hosts: ['local-codex'], publicBaseUrl: () => { throw Error('Browser push must not read external entry'); }, read: async () => ({ thread: { id: 'thread', name: 'Subject' } }), send: async (_device, payload) => { sent.push(JSON.parse(payload)); } }); t.after(() => service.close());
  store.watch('admin-a', 'native-server', 'local-codex', 'thread', 'input'); store.finish(store.watches()[0]!, 'turn', 'completed'); await service.tick(); assert.equal(sent[0].notification.navigate, 'https://installed-app.example/servers/app/local/thread?hostId=local-codex');
});
