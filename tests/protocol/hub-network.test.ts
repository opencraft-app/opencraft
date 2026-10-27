import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { HubNetwork } from '../../packages/hub-network/src/node';
import { HUB_CONTROL_PATH, HUB_PROTOCOL, MAX_HOPS } from '../../packages/hub-network/src/contract';
import { HubRouting } from '../../packages/hub-network/src/routing';
import { HubStore, parseInvitation, signed } from '../../packages/hub-network/src/store';
import { createHubController } from '../../packages/hub-network/src/controller';
import { createRelayServer } from '../../apps/relay-server/src/server';
import { AssertionSigner } from '../../packages/identity-core/src/node';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

const principal = { provider: 'enterprise-identity', subject: '123', displayName: 'Network member', expiresAt: Date.now() + 3600_000 };
const keys = () => { const pair = generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }; };
async function waitFor(check: () => boolean) { const until = Date.now() + 8000; while (!check()) { if (Date.now() > until) throw new Error('Hub condition timeout'); await new Promise(r => setTimeout(r, 20)); } }
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
const command = (node: HubNetwork, input: Record<string, unknown>) => node.command({ revision: node.store.state.revision, ...input }, 'test-administrator');
function configure(node: HubNetwork, endpoint: string, extra = {}) { command(node, { action: 'configure', name: 'Test Hub', endpoint, origin: '', accepting: true, forwarding: true, ...extra }); }
function invite(node: HubNetwork, origins: string[], allowTransit = true) { return (command(node, { action: 'invite', origins, allowTransit }) as { invitation: string }).invitation; }
async function virtualGet(base: string, path: string, auth = true) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(base + path, { headers: { host: 'team-c.test', ...(auth ? { 'x-test-auth': 'yes' } : {}) } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end();
  });
}
test('three real Hub nodes stream HTTP and WS; target owns membership; withdraw and reconnect preserve identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-network-')), cleanup: (() => unknown)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(dir, { recursive: true, force: true }); });
  const pair = keys(), authority = { issuer: 'network-auth', publicKey: pair.publicKey, providers: ['enterprise-identity'] };
  const a = new HubNetwork(join(dir, 'a.json'), { authority }), b = new HubNetwork(join(dir, 'b.json'), { authority }), c = new HubNetwork(join(dir, 'c.json'), { authority });
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
  configure(a, base); configure(b, `http://127.0.0.1:${bp}`); configure(c, `http://127.0.0.1:${cPeerPort}`, { origin: 'http://team-c.test' });
  const abInvite = invite(a, ['http://team-c.test']); command(b, { action: 'connect', invitation: abInvite, trustIdentity: true });
  const bcInvite = invite(b, ['http://team-c.test'], false); command(c, { action: 'connect', invitation: bcInvite, trustIdentity: true });
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
  const unused = parseInvitation(invite(b, [], false)); command(b, { action: 'revoke', id: unused.id });
  assert.equal(ws.readyState, WebSocket.OPEN, 'unused invitation changes preserve unrelated active traffic');
  const stillOpen = once(ws, 'message'); ws.send('after-invitation'); assert.equal((await stillOpen)[0].toString(), 'after-invitation');
  const closed = once(ws, 'close'); store.set(principal, 'member', false, 'test'); await closed;
  assert.equal((await virtualGet(base, '/')).status, 403, 'target revocation applies through both hops');
  store.set(principal, 'member', true, 'test');
  configure(b, `http://127.0.0.1:${bp}`, { forwarding: false }); await waitFor(() => a.routes().length === 0);
  configure(b, `http://127.0.0.1:${bp}`, { forwarding: true }); await waitFor(() => a.routes().length === 1);
  const id = c.store.id; c.close(); await waitFor(() => a.routes().length === 0);
  assert.equal((await virtualGet(base, '/')).status, 403, 'withdrawn public host has no route');
  const cAgain = new HubNetwork(join(dir, 'c.json')); cleanup.push(() => cAgain.close()); assert.equal(cAgain.store.id, id);
  cServer.removeAllListeners('upgrade'); cServer.on('upgrade', (req, sock, head) => { if (!cAgain.handleUpgrade(req, sock, head)) sock.destroy(); });
  // Target membership uses the replacement authority owner after a real process lifecycle.
  const core2 = await createWorkbenchWebServer({ root, loopbackOnly: false, accessService: new InstanceAccess(store, [cAgain]) }); cleanup.push(() => core2.close());
  const cp2 = await core2.listen({ host: '127.0.0.1', port: 0 }); cAgain.start(cp2.port);
  await waitFor(() => a.routes().length === 1); assert.equal((await virtualGet(base, '/')).status, 200);
  const invitationId = parseInvitation(bcInvite).id; command(b, { action: 'revoke', id: invitationId });
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
  const pair = keys(), a = new HubNetwork(join(dir, 'a.json'), { authority: { issuer: 'auth', publicKey: pair.publicKey, providers: ['enterprise-identity'] } }), b = new HubNetwork(join(dir, 'b.json'));
  t.after(() => { a.close(); b.close(); }); configure(a, 'http://127.0.0.1:9999');
  assert.equal((await stat(join(dir, 'a.json'))).mode & 0o077, 0);
  assert.throws(() => new HubStore(join(dir, 'a.json')), /lock/i);
  const value = invite(a, ['https://team.test'], false), payload = parseInvitation(value);
  assert.throws(() => command(b, { action: 'connect', invitation: value }), /explicitly/);
  const tampered = JSON.parse(Buffer.from(value, 'base64url').toString()); tampered.payload.endpoint = 'https://attacker.test';
  assert.throws(() => parseInvitation(Buffer.from(JSON.stringify(tampered)).toString('base64url')));
  const expired = { ...payload, expiresAt: Date.now() - 1 };
  assert.throws(() => parseInvitation(Buffer.from(JSON.stringify({ payload: expired, signature: signed(expired, a.store.state.privateKey) })).toString('base64url')));
  assert.throws(() => configure(b, 'http://unsafe.test'));
  command(b, { action: 'connect', invitation: value, trustIdentity: true }); assert.equal(b.store.state.authority?.issuer, 'auth');
  const stale = b.command({ action: 'disconnect', id: payload.id, revision: 0 }, 'test'); assert.equal('conflict' in stale, true);
  const state = JSON.parse(await readFile(join(dir, 'a.json'), 'utf8')); assert.equal(state.invitations[0].credential, undefined); assert.equal(state.invitations[0].hash.length, 64);
  const c = new HubStore(join(dir, 'c.json')); c.state.authority = a.store.state.authority; c.state.origin = 'https://team.test';
  t.after(() => c.close());
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
  const a = new HubNetwork(join(dir, 'a.json')), b = new HubStore(join(dir, 'b.json')), attacker = new HubStore(join(dir, 'attacker.json'));
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => { if (!a.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(server), endpoint = `http://127.0.0.1:${port}`; a.start(port); configure(a, endpoint);
  t.after(async () => { a.close(); b.close(); attacker.close(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const token = parseInvitation(invite(a, []));
  const connect = async () => {
    const ws = new WebSocket(endpoint.replace('http:', 'ws:') + HUB_CONTROL_PATH, HUB_PROTOCOL, { headers: { authorization: 'Bearer ' + token.credential } });
    ws.on('error', () => {}); const challenge = once(ws, 'message'); await once(ws, 'open');
    return { ws, challenge: JSON.parse((await challenge)[0].toString()) };
  };
  const hello = (node: HubStore, challenge: string) => ({ type: 'hello', hubId: node.id, publicKey: node.state.publicKey, signature: signed({ challenge, audience: a.store.id }, node.state.privateKey) });
  const first = await connect(), original = hello(b, first.challenge.challenge);
  const ready = once(first.ws, 'message'); first.ws.send(JSON.stringify(original)); assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
  assert.equal(a.snapshot().peers[0]!.hubId, b.id);
  const rogue = await connect(), rogueClosed = once(rogue.ws, 'close'); rogue.ws.send(JSON.stringify(hello(attacker, rogue.challenge.challenge))); await rogueClosed;
  assert.ok(a.links.has(b.id), 'wrong key cannot replace the enrolled peer');
  const replay = await connect(), replayClosed = once(replay.ws, 'close'); replay.ws.send(JSON.stringify(original)); await replayClosed;
  assert.ok(a.links.has(b.id));
  const pending = await connect(), pendingClosed = once(pending.ws, 'close');
  command(a, { action: 'revoke', id: token.id });
  pending.ws.send(JSON.stringify(hello(b, pending.challenge.challenge))); await pendingClosed;
  await waitFor(() => !a.links.has(b.id));
});

test('packaged offline enrollment boots a token-free Headless team with pinned Hub identity and core admission', { timeout: 30000 }, async t => {
  const { build } = await import('esbuild'), { buildHeadlessBundle } = await import('../../scripts/package-headless-linux.mjs');
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { pathToFileURL } = await import('node:url');
  await mkdir(join(process.cwd(), '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.runtime/hub-bootstrap-')), data = join(dir, 'data'), web = join(dir, 'web');
  await mkdir(data); await mkdir(web); await writeFile(join(web, 'index.html'), 'Bootstrapped private team');
  await writeFile(join(web, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'hub-bootstrap-fixture', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const operator = join(dir, 'hub-admin.mjs'), bundle = join(dir, 'headless.mjs');
  await build({ entryPoints: [join(process.cwd(), 'scripts/hub-admin.ts')], outfile: operator, bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await buildHeadlessBundle(bundle);
  const pair = keys(), a = new HubNetwork(join(dir, 'a.json'), { authority: { issuer: 'bootstrap-login', publicKey: pair.publicKey, providers: ['enterprise-identity'] } }); configure(a, 'http://127.0.0.1:9');
  const invitation = invite(a, ['http://bootstrap-team.test']), file = join(dir, 'command.json'), state = join(data, 'hub-network.json');
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
  const { startHeadlessServer } = await import('../../scripts/headless-server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'headless-managed-hub-'));
  const data = join(dir, 'data'), web = join(dir, 'web');
  await mkdir(data,{mode:0o700}); await mkdir(web);
  await writeFile(join(web, 'index.html'), 'backend static assets');
  await writeFile(join(web, 'version.json'), JSON.stringify({schemaVersion:1,buildId:'fixture',headlessServer:true,headlessHostId:'opencraft-server'}));
  const pair = keys(), authority = {issuer:'managed-entry-fixture',publicKey:pair.publicKey,providers:['enterprise-identity']};
  const upstream = new HubNetwork(join(dir, 'upstream.json'), {authority});
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
  configure(upstream,base); upstream.start(upstreamPort);
  const bootstrap = new HubNetwork(join(data,'hub-network.json'));
  try {
    command(bootstrap,{action:'connect',invitation:invite(upstream,['http://team-c.test'],false),trustIdentity:true,publishOrigin:'http://team-c.test'});
  } finally {bootstrap.close();}
  app = await startHeadlessServer({root:dir,webRoot:web,dataDirectory:data,port:0,hubTargetPort:entryPort,
    accessControl:true,accessMemberProviders:['enterprise-identity'],
    startAgentHost:async () => ({websocketUrl:'ws://127.0.0.1:9/rpc',async close(){}})});
  await waitFor(() => upstream.routes().some(route => route.service.origin === 'http://team-c.test'));
  assert.equal((await virtualGet(base,'/')).body,text);
  text = 'managed Web release two';
  assert.equal((await virtualGet(base,'/')).body,text,'a Web-only update must not leave Hub clients on backend assets');
});
