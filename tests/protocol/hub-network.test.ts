import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { HubNetwork } from '../../packages/hub-network/src/node';
import { HubStateFile, openLocalHubNetwork } from '../../packages/hub-network/src/store-file.js';
import { HUB_CONTROL_PATH, HUB_PROTOCOL, MAX_HOPS } from '../../packages/hub-network/src/contract';
import { HubRouting } from '../../packages/hub-network/src/routing';
import { MemoryHubStore, parseInvitation, signed } from '../../packages/hub-network/src/store';
import { documentHubStore } from '../../packages/hub-network/src/document-hub-store';
import { memoryStateDocumentStore } from '@opencraft/document-storage/state';
import { createHubController } from '../../packages/hub-network/src/controller';
import { openHubNetwork } from '../../packages/hub-network/src/open';
import { createRelayServer } from '../../apps/relay-server/src/server';
import { AssertionSigner } from '../../packages/identity-core/src/node';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index';
import { createWorkbenchWebServer } from '../../apps/headless-server/src/serve-workbench-web.mjs';

const principal = { provider: 'enterprise-identity', subject: '123', displayName: 'Network member', expiresAt: Date.now() + 3600_000 };
const keys = () => { const pair = generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }; };
async function waitFor(check: () => boolean) { const until = Date.now() + 8000; while (!check()) { if (Date.now() > until) throw new Error('Hub condition timeout'); await new Promise(r => setTimeout(r, 20)); } }
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
// File-backed test Hubs run in durable mode: a change resolves after the state file was written.
const command = (node: HubNetwork, input: Record<string, unknown>) => node.apply({ revision: node.store.state.revision, ...input }, 'test-administrator');
async function configure(node: HubNetwork, endpoint: string, extra = {}) { await command(node, { action: 'configure', name: 'Test Hub', endpoint, origin: '', accepting: true, forwarding: true, ...extra }); }
async function invite(node: HubNetwork, origins: string[], allowTransit = true) { return ((await command(node, { action: 'invite', origins, allowTransit })) as { invitation: string }).invitation; }
/** A Hub identity read from a state file without a running Hub; closing releases the file. */
async function stateOwner(path: string) { const file = await HubStateFile.open(path); return { store: new MemoryHubStore(file.state), close: () => file.close() }; }
async function virtualGet(base: string, path: string, auth = true) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(base + path, { headers: { host: 'team-c.test', ...(auth ? { 'x-test-auth': 'yes' } : {}) } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end();
  });
}
// Network processes keep the Hub state file and its writer lock in a Worker;
// a change is acknowledged only after the Worker wrote it.
test('a network-process Hub persists through its owner and releases the state lock on close', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-owner-')), path = join(dir, 'hub.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = keys(), authority = { issuer: 'owner-login', publicKey: pair.publicKey, providers: ['enterprise-identity'] };
  let opened = await openHubNetwork(path, { authority });
  const { node } = opened;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).authority, authority, 'configuring the authority at open is persisted');
  assert.throws(() => node.command({ revision: node.store.state.revision, action: 'configure', name: 'Durable Hub', endpoint: '', origin: '', accepting: false, forwarding: false }, 'test-administrator'), /durableCommand/);
  const result = await node.apply({ revision: node.store.state.revision, action: 'configure', name: 'Durable Hub', endpoint: '', origin: '', accepting: false, forwarding: false }, 'test-administrator');
  assert.equal('conflict' in result, false);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).name, 'Durable Hub', 'acknowledged after the owner wrote it');
  await assert.rejects(HubStateFile.open(path), Error, 'the owner holds the process writer lock');
  await opened.close();
  opened = await openHubNetwork(path);
  try {
    assert.equal(opened.node.store.state.name, 'Durable Hub');
    assert.equal(opened.node.store.id, node.store.id);
  } finally { await opened.close(); }
});

test('Hub state documents keep one identity and existing compact state files', async t => {
  const documents = memoryStateDocumentStore(), hub = documentHubStore(documents);
  const [first, second] = await Promise.all([hub.open(), hub.open()]);
  assert.equal(first.publicKey, second.publicKey, 'concurrent first opens never replace the created identity');
  await assert.rejects(hub.save({ ...first, ...keys(), revision: 1 }), /Invalid Hub state|another Hub identity/);
  await hub.save({ ...first, name: 'Renamed', revision: 1 }); assert.equal((await hub.open()).name, 'Renamed');
  const dir = await mkdtemp(join(tmpdir(), 'hub-legacy-')), path = join(dir, 'hub-network.json'); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify(first), { mode: 0o600 });
  const owner = await stateOwner(path); assert.equal(owner.store.state.publicKey, first.publicKey, 'the existing node keeps its identity'); await owner.close();
  await chmod(path, 0o644);
  await assert.rejects(HubStateFile.open(path), /private/);
});

test('three real Hub nodes stream HTTP and WS; target owns membership; withdraw and reconnect preserve identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-network-')), cleanup: (() => unknown)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(dir, { recursive: true, force: true }); });
  const pair = keys(), authority = { issuer: 'network-auth', publicKey: pair.publicKey, providers: ['enterprise-identity'] };
  const a = await openLocalHubNetwork(join(dir, 'a.json'), { authority }), b = await openLocalHubNetwork(join(dir, 'b.json'), { authority }), c = await openLocalHubNetwork(join(dir, 'c.json'), { authority });
  cleanup.push(() => a.close(), () => b.close(), () => c.close());
  const store = new MembershipStore(join(dir, 'members.sqlite')); cleanup.push(() => store.close()); store.set(principal, 'member', true, 'test');
  const root = join(dir, 'web'); await mkdir(root); await writeFile(join(root, 'index.html'), 'Team C private workbench');
  const targetAccess = new InstanceAccess(store, [c]);
  const core = await createWorkbenchWebServer({ root, loopbackOnly: false, accessService: targetAccess,
    desktopService: { accept(ws: WebSocket) { ws.send('from-c'); ws.on('message', message => ws.send(message)); }, close() {} }, desktopAccess: 'trusted-internal' });
  cleanup.push(() => core.close()); const cp = await core.listen({ host: '127.0.0.1', port: 0 });
  let finishEvents: (() => void) | undefined;
  const dataServer = createServer((req, res) => {
    if (!['/upload', '/events'].includes(req.url ?? '')) { core.server.emit('request', req, res); return; }
    const admission = targetAccess.admissionStatus(req); if (admission !== 204) { res.writeHead(admission); res.end(); return; }
    if (req.url === '/upload') { const hash = createHash('sha256'); req.on('data', chunk => hash.update(chunk)); req.on('end', () => res.end(hash.digest('hex'))); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); finishEvents = () => res.end('data: last\n\n'); }
  });
  dataServer.on('upgrade', (req, sock, head) => core.server.emit('upgrade', req, sock, head));
  const dataPort = await listen(dataServer); cleanup.push(() => new Promise<void>(resolve => { dataServer.close(() => resolve()); dataServer.closeAllConnections(); }));
  core.server.prependListener('upgrade', () => {});
  // Separate peer listener models a department's directly reachable endpoint; business target remains pinned.
  const bServer = createServer((_req, res) => { res.writeHead(404); res.end(); }), cServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
  for (const [node, server] of [[b, bServer], [c, cServer]] as const) { server.on('upgrade', (req, sock, head) => { if (!node.handleUpgrade(req, sock, head)) sock.destroy(); }); cleanup.unshift(() => new Promise<void>(resolve => server.close(() => resolve()))); }
  const bp = await listen(bServer), cPeerPort = await listen(cServer);
  const provider = { authenticate: (req: any) => req.headers['x-test-auth'] === 'yes' ? principal : null };
  const scope = { issuer: authority.issuer, instanceId: 'legacy', origin: 'http://legacy.test' };
  const relay = createRelayServer([{ ...scope, credential: randomBytes(32).toString('base64url'), signer: new AssertionSigner(scope, pair.privateKey), identityProvider: provider }], {
    hub: a, networkRoute: service => ({ hubId: service.hubId, instanceId: service.hubId, origin: service.origin, credential: '', identityProvider: provider,
      signer: new AssertionSigner({ issuer: authority.issuer, instanceId: service.hubId, origin: service.origin }, pair.privateKey) }) });
  cleanup.unshift(() => relay.close()); const ap = await listen(relay.server), base = `http://127.0.0.1:${ap}`;
  a.start(ap); b.start(bp); c.start(dataPort);
  await configure(a, base); await configure(b, `http://127.0.0.1:${bp}`); await configure(c, `http://127.0.0.1:${cPeerPort}`, { origin: 'http://team-c.test' });
  const abInvite = await invite(a, ['http://team-c.test']); await command(b, { action: 'connect', invitation: abInvite, trustIdentity: true });
  const bcInvite = await invite(b, ['http://team-c.test'], false); await command(c, { action: 'connect', invitation: bcInvite, trustIdentity: true });
  await waitFor(() => a.routes().some(r => r.service.hubId === c.store.id));
  assert.deepEqual(a.routes()[0]!.path, [b.store.id, c.store.id]);
  assert.equal((await virtualGet(base, '/', false)).status, 401);
  const page = await virtualGet(base, '/'); assert.equal(page.status, 200); assert.match(page.body, /Team C/);
  assert.equal((await virtualGet(base, '/__opencraft_updates')).status, 403);
  const upload = Buffer.alloc(3 * 1024 * 1024, 17), checksum = createHash('sha256').update(upload).digest('hex');
  const uploaded = await new Promise<string>((resolve, reject) => {
    const req = request(base + '/upload', { method: 'POST', headers: { host: 'team-c.test', origin: 'http://team-c.test', 'x-test-auth': 'yes' } }, res => {
      let text = ''; res.on('data', c => text += c); res.once('end', () => resolve(text));
    }); req.on('error', reject); req.end(upload);
  }); assert.equal(uploaded, checksum);
  await new Promise<void>((resolve, reject) => {
    let first = false;
    request(base + '/events', { headers: { host: 'team-c.test', 'x-test-auth': 'yes' } }, res => {
      res.on('data', chunk => { if (!first) { first = true; assert.match(chunk.toString(), /first/); assert.ok(finishEvents, 'first SSE event arrives while final event is withheld'); finishEvents!(); finishEvents = undefined; } });
      res.once('end', () => { assert.ok(first); resolve(); });
    }).on('error', reject).end();
  });
  assert.equal((await virtualGet(base, '/__opencraft_access/members')).status, 403, 'network connection grants no administration');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/desktop/connect', { origin: 'http://team-c.test', headers: { host: 'team-c.test', 'x-test-auth': 'yes' } });
  const first = once(ws, 'message'); await once(ws, 'open'); assert.equal((await first)[0].toString(), 'from-c');
  const echo = once(ws, 'message'); ws.send(Buffer.alloc(30_000, 9)); assert.deepEqual((await echo)[0], Buffer.alloc(30_000, 9));
  const oldControl = b.links.get(c.store.id)!;
  oldControl.ws.terminate();
  await waitFor(() => !!b.links.get(c.store.id) && b.links.get(c.store.id) !== oldControl);
  const afterControlLoss = once(ws, 'message'); ws.send('control reconnected');
  assert.equal((await afterControlLoss)[0].toString(), 'control reconnected', 'control loss preserves established end-to-end data');
  const unused = parseInvitation(await invite(b, [], false)); await command(b, { action: 'revoke', id: unused.id });
  assert.equal(ws.readyState, WebSocket.OPEN, 'unused invitation changes preserve unrelated active traffic');
  const stillOpen = once(ws, 'message'); ws.send('after-invitation'); assert.equal((await stillOpen)[0].toString(), 'after-invitation');
  const closed = once(ws, 'close'); store.set(principal, 'member', false, 'test'); await closed;
  assert.equal((await virtualGet(base, '/')).status, 403, 'target revocation applies through both hops');
  store.set(principal, 'member', true, 'test');
  await configure(b, `http://127.0.0.1:${bp}`, { forwarding: false }); await waitFor(() => a.routes().length === 0);
  await configure(b, `http://127.0.0.1:${bp}`, { forwarding: true }); await waitFor(() => a.routes().length === 1);
  const id = c.store.id; c.close(); await waitFor(() => a.routes().length === 0);
  assert.equal((await virtualGet(base, '/')).status, 403, 'withdrawn public host has no route');
  const cAgain = await openLocalHubNetwork(join(dir, 'c.json')); cleanup.push(() => cAgain.close()); assert.equal(cAgain.store.id, id);
  cServer.removeAllListeners('upgrade'); cServer.on('upgrade', (req, sock, head) => { if (!cAgain.handleUpgrade(req, sock, head)) sock.destroy(); });
  // Target membership uses the replacement authority owner after a real process lifecycle.
  const core2 = await createWorkbenchWebServer({ root, loopbackOnly: false, accessService: new InstanceAccess(store, [cAgain]) }); cleanup.push(() => core2.close());
  const cp2 = await core2.listen({ host: '127.0.0.1', port: 0 }); cAgain.start(cp2.port);
  await waitFor(() => a.routes().length === 1); assert.equal((await virtualGet(base, '/')).status, 200);
  const invitationId = parseInvitation(bcInvite).id; await command(b, { action: 'revoke', id: invitationId });
  await waitFor(() => a.routes().length === 0); assert.equal(b.snapshot().peers.length, 1);
  const snapshot = JSON.stringify(a.snapshot()); assert.ok(!snapshot.includes(pair.privateKey)); assert.ok(!snapshot.includes('credential')); assert.ok(!snapshot.includes('hash'));
});

test('settings require instance administrator, same-origin JSON and retain true operator audit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-admin-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = await createHubController(join(dir, 'controller.json'), join(dir, 'node.json')); t.after(() => controller.close());
  let current: string | null = null;
  const server = createServer(async (req, res) => { if (!await controller.handle(req, res, () => current)) { res.writeHead(404); res.end(); } });
  const port = await listen(server), origin = `http://127.0.0.1:${port}`; t.after(() => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }));
  assert.equal((await fetch(origin + '/__opencraft_hub/settings')).status, 403);
  current = '["enterprise-identity","administrator"]';
  const snapshot = await (await fetch(origin + '/__opencraft_hub/settings')).json();
  const body = JSON.stringify({ revision: snapshot.revision, action: 'configure', name: 'Configured', endpoint: origin, origin: '', accepting: true, forwarding: true });
  assert.equal((await fetch(origin + '/__opencraft_hub/settings', { method: 'POST', headers: { origin: 'https://other.test', 'content-type': 'application/json' }, body })).status, 403);
  const result = await fetch(origin + '/__opencraft_hub/settings', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
  assert.equal(result.status, 200); assert.equal((await result.json()).snapshot.audit[0].operator, current);
  assert.equal((await fetch(origin + '/__opencraft_hub/settings', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })).status, 409);
});

test('private persistence, invitation signature/expiry, CAS, explicit identity trust and origin scope', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-state-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = keys(), a = await openLocalHubNetwork(join(dir, 'a.json'), { authority: { issuer: 'auth', publicKey: pair.publicKey, providers: ['enterprise-identity'] } }), b = await openLocalHubNetwork(join(dir, 'b.json'));
  t.after(() => { a.close(); b.close(); }); await configure(a, 'http://127.0.0.1:9999');
  assert.equal((await stat(join(dir, 'a.json'))).mode & 0o077, 0);
  await assert.rejects(HubStateFile.open(join(dir, 'a.json')), /lock/i);
  const value = await invite(a, ['https://team.test'], false), payload = parseInvitation(value);
  await assert.rejects(command(b, { action: 'connect', invitation: value }), /explicitly/);
  const tampered = JSON.parse(Buffer.from(value, 'base64url').toString()); tampered.payload.endpoint = 'https://attacker.test';
  assert.throws(() => parseInvitation(Buffer.from(JSON.stringify(tampered)).toString('base64url')));
  const expired = { ...payload, expiresAt: Date.now() - 1 };
  assert.throws(() => parseInvitation(Buffer.from(JSON.stringify({ payload: expired, signature: signed(expired, a.store.state.privateKey) })).toString('base64url')));
  await assert.rejects(configure(b, 'http://unsafe.test'));
  await command(b, { action: 'connect', invitation: value, trustIdentity: true }); assert.equal(b.store.state.authority?.issuer, 'auth');
  const stale = await b.apply({ action: 'disconnect', id: payload.id, revision: 0 }, 'test'); assert.equal('conflict' in stale, true);
  const state = JSON.parse(await readFile(join(dir, 'a.json'), 'utf8')); assert.equal(state.invitations[0].credential, undefined); assert.equal(state.invitations[0].hash.length, 64);
  const cOwner = await stateOwner(join(dir, 'c.json')), c = cOwner.store; c.state.authority = a.store.state.authority; c.state.origin = 'https://team.test';
  t.after(() => cOwner.close());
  const route = { service: c.service()!, path: [c.id] }, table = new HubRouting(a.store.id);
  table.receive(c.id, 1, [route], { allowTransit: false, origins: ['https://other.test'] }); assert.equal(table.all().length, 0);
  table.receive(c.id, 2, [route], { allowTransit: false, origins: ['https://team.test'] }); assert.equal(table.all().length, 1);
  assert.throws(() => table.receive(c.id, 2, [], { allowTransit: true, origins: [] }));
  const overlong = [b.store.id, ...Array.from({ length: MAX_HOPS - 2 }, (_, i) => 'hub-' + String(i).padStart(40, '0')), c.id];
  table.receive(b.store.id, 1, [{ service: route.service, path: overlong }], { allowTransit: true, origins: ['https://team.test'] });
  assert.equal(table.all().length, 1, 'overlong route is ignored without replacing the valid independent route');
  table.receive(c.id, 3, [{ ...route, path: [c.id, a.store.id, c.id] }], { allowTransit: true, origins: ['https://team.test'] }); assert.equal(table.all().length, 0, 'looping routes are not installed');
});

test('redeemed invitation pins the peer key; challenge replay and revocation during enrollment are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-handshake-'));
  const a = await openLocalHubNetwork(join(dir, 'a.json')), bOwner = await stateOwner(join(dir, 'b.json')), attackerOwner = await stateOwner(join(dir, 'attacker.json')), b = bOwner.store, attacker = attackerOwner.store;
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => { if (!a.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(server), endpoint = `http://127.0.0.1:${port}`; a.start(port); await configure(a, endpoint);
  t.after(async () => { a.close(); await bOwner.close(); await attackerOwner.close(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const token = parseInvitation(await invite(a, []));
  const connect = async () => {
    const ws = new WebSocket(endpoint.replace('http:', 'ws:') + HUB_CONTROL_PATH, HUB_PROTOCOL, { headers: { authorization: 'Bearer ' + token.credential } });
    ws.on('error', () => {}); const challenge = once(ws, 'message'); await once(ws, 'open');
    return { ws, challenge: JSON.parse((await challenge)[0].toString()) };
  };
  const hello = (node: MemoryHubStore, challenge: string) => ({ type: 'hello', hubId: node.id, publicKey: node.state.publicKey, signature: signed({ challenge, audience: a.store.id }, node.state.privateKey) });
  const first = await connect(), original = hello(b, first.challenge.challenge);
  const ready = once(first.ws, 'message'); first.ws.send(JSON.stringify(original)); assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
  assert.equal(a.snapshot().peers[0]!.hubId, b.id);
  const rogue = await connect(), rogueClosed = once(rogue.ws, 'close'); rogue.ws.send(JSON.stringify(hello(attacker, rogue.challenge.challenge))); await rogueClosed;
  assert.ok(a.links.has(b.id), 'wrong key cannot replace the enrolled peer');
  const replay = await connect(), replayClosed = once(replay.ws, 'close'); replay.ws.send(JSON.stringify(original)); await replayClosed;
  assert.ok(a.links.has(b.id));
  const pending = await connect(), pendingClosed = once(pending.ws, 'close');
  await command(a, { action: 'revoke', id: token.id });
  pending.ws.send(JSON.stringify(hello(b, pending.challenge.challenge))); await pendingClosed;
  await waitFor(() => !a.links.has(b.id));
});

test('packaged offline enrollment boots a token-free Headless team with pinned Hub identity and core admission', { timeout: 30000 }, async t => {
  const { build } = await import('esbuild'), { buildHeadlessBundle } = await import('../../scripts/packaging/package-headless-linux.mjs');
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { pathToFileURL } = await import('node:url');
  await mkdir(join(process.cwd(), '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.runtime/hub-bootstrap-')), data = join(dir, 'data'), web = join(dir, 'web');
  await mkdir(data, { mode: 0o700 }); await mkdir(web); await writeFile(join(web, 'index.html'), 'Bootstrapped private team');
  await writeFile(join(web, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'hub-bootstrap-fixture', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const operator = join(dir, 'hub-admin.mjs'), bundle = join(dir, 'headless.mjs');
  await build({ entryPoints: [join(process.cwd(), 'scripts/admin/hub-admin.ts')], outfile: operator, bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await buildHeadlessBundle(bundle);
  const pair = keys(), a = await openLocalHubNetwork(join(dir, 'a.json'), { authority: { issuer: 'bootstrap-login', publicKey: pair.publicKey, providers: ['enterprise-identity'] } }); await configure(a, 'http://127.0.0.1:9');
  const invitation = await invite(a, ['http://bootstrap-team.test']), file = join(dir, 'command.json'), state = join(data, 'hub-network.json');
  await writeFile(file, JSON.stringify({ action: 'connect', invitation, trustIdentity: true, publishOrigin: 'http://bootstrap-team.test' }), { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, [operator, state, file]);
  const id = JSON.parse(result.stdout).snapshot.hubId; assert.ok(!result.stdout.includes(invitation));
  const { startHeadlessServer, parseHeadlessArguments } = await import(pathToFileURL(bundle).href);
  const options = { ...parseHeadlessArguments(['--data-dir', data, '--access-control', '--access-member-provider', 'enterprise-identity'], {}), root: dir, webRoot: web, port: 0,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:9/rpc', async close() {} }) };
  let app: any;
  t.after(async () => { await app?.close(); a.close(); await rm(dir, { recursive: true, force: true }); });
  const signer = new AssertionSigner({ issuer: 'bootstrap-login', instanceId: id, origin: 'http://bootstrap-team.test' }, pair.privateKey);
  const call = (path: string, signed = true) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${app.listenPort}${path}`, { headers: { host: 'bootstrap-team.test', ...(signed ? { 'x-opencraft-relay-assertion': signer.issue(principal, 'GET', path) } : {}) } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode!, body })); }); req.on('error', reject); req.end();
  });
  app = await startHeadlessServer(options);
  assert.ok([401, 403].includes((await call('/', false)).status));
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/__opencraft_hub/settings')).status, 403, 'default verified member is not an administrator');
  assert.equal((await call('/__opencraft_access/session')).status, 200);
  await assert.rejects(promisify(execFile)(process.execPath, [operator, state], { timeout: 3000 }), /lock/i);
  await app.close(); app = await startHeadlessServer(options);
  assert.equal((await call('/')).status, 200, 'original identity issuer and published service survive restart');
});

test('Headless publishes its managed Web entry through the real Hub transport', async t => {
  const { startHeadlessServer } = await import('../../apps/headless-server/src/headless-server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'headless-managed-hub-'));
  const data = join(dir, 'data'), web = join(dir, 'web');
  await mkdir(data,{mode:0o700}); await mkdir(web);
  await writeFile(join(web, 'index.html'), 'backend static assets');
  await writeFile(join(web, 'version.json'), JSON.stringify({schemaVersion:1,buildId:'fixture',headlessServer:true,headlessHostId:'opencraft-server'}));
  const pair = keys(), authority = {issuer:'managed-entry-fixture',publicKey:pair.publicKey,providers:['enterprise-identity']};
  const upstream = await openLocalHubNetwork(join(dir, 'upstream.json'), {authority});
  const provider = {authenticate:(req: any) => req.headers['x-test-auth'] === 'yes' ? principal : null};
  const relay = createRelayServer([], {hub:upstream,networkRoute:service => ({hubId:service.hubId,instanceId:service.hubId,origin:service.origin,credential:'',identityProvider:provider,
    signer:new AssertionSigner({issuer:authority.issuer,instanceId:service.hubId,origin:service.origin},pair.privateKey)})});
  let app: Awaited<ReturnType<typeof startHeadlessServer>> | undefined;
  let text = 'managed Web release one';
  const entry = createServer((_req,res) => res.end(text));
  t.after(async () => {
    await app?.close(); upstream.close(); await relay.close();
    await new Promise<void>(resolve => {entry.close(() => resolve());entry.closeAllConnections();});
    await rm(dir,{recursive:true,force:true});
  });
  const entryPort = await listen(entry), upstreamPort = await listen(relay.server);
  const base = `http://127.0.0.1:${upstreamPort}`;
  await configure(upstream,base); upstream.start(upstreamPort);
  const bootstrap = await openLocalHubNetwork(join(data,'hub-network.json'));
  try {
    await command(bootstrap,{action:'connect',invitation:await invite(upstream,['http://team-c.test'],false),trustIdentity:true,publishOrigin:'http://team-c.test'});
  } finally {bootstrap.close();}
  app = await startHeadlessServer({root:dir,webRoot:web,dataDirectory:data,port:0,hubTargetPort:entryPort,
    accessControl:true,accessMemberProviders:['enterprise-identity'],
    startAgentHost:async () => ({websocketUrl:'ws://127.0.0.1:9/rpc',async close(){}})});
  await waitFor(() => upstream.routes().some(route => route.service.origin === 'http://team-c.test'));
  assert.equal((await virtualGet(base,'/')).body,text);
  text = 'managed Web release two';
  assert.equal((await virtualGet(base,'/')).body,text,'a Web-only update must not leave Hub clients on backend assets');
});

test('revoking a peer also retires data retained after its control transport disappeared', {timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-detached-revoke-'));
  const authority = {issuer:'retained-test',publicKey:keys().publicKey,providers:['fixture']};
  const a = await openLocalHubNetwork(join(dir,'a.json'),{authority}), b = await openLocalHubNetwork(join(dir,'b.json'),{authority});
  const ingress = createServer(), target = createServer((_req,res) => { res.write('held'); });
  ingress.on('upgrade',(req,socket,head) => { if (!a.handleUpgrade(req,socket,head)) socket.destroy(); });
  const ap = await listen(ingress), bp = await listen(target);
  t.after(async () => { a.close(); b.close(); ingress.closeAllConnections(); ingress.close(); target.closeAllConnections(); target.close(); await rm(dir,{recursive:true,force:true}); });
  a.start(ap); b.start(bp); await configure(a,`http://127.0.0.1:${ap}`); await configure(b,`http://127.0.0.1:${bp}`,{origin:'http://retained.test'});
  const invitation = await invite(a,['http://retained.test']); await command(b,{action:'connect',invitation,trustIdentity:true});
  await waitFor(() => a.routes().some(r => r.service.hubId === b.store.id));
  const stream = await a.open(b.store.id);
  const response = await new Promise<import('node:http').IncomingMessage>((resolve,reject) => {
    request({host:'retained.test',path:'/',headers:{host:'retained.test'},createConnection:()=>stream},resolve).on('error',reject).end();
  });
  assert.equal(response.statusCode,200);
  response.on('error',()=>{}); response.resume();
  a.links.get(b.store.id)!.ws.terminate();
  await waitFor(() => !a.links.has(b.store.id));
  assert.equal(stream.destroyed,false,'established data survived control loss');
  const ended = once(stream,'close');
  await command(a,{action:'revoke',id:parseInvitation(invitation).id});
  await ended; assert.equal(stream.destroyed,true,'detached peer still participates in revocation');
});
