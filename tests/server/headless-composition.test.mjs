import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHeadlessServer } from '../../scripts/headless-server.mjs';
import { buildHeadlessBundle } from '../../scripts/package-headless-linux.mjs';
import { loadLocalMachineAccess } from '../../scripts/local-machine-access.mjs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';

async function fixture(t) {
  const runtime = fileURLToPath(new URL('../../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'headless-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, 'web'); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Public workbench</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'composition-test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  let starts = 0;
  const options = { root, webRoot, dataDirectory: join(root, 'data'), port: 0,
    startAgentHost: async () => { starts++; return { websocketUrl: 'ws://127.0.0.1:9/rpc', close: async () => {} }; } };
  return { root, options, starts: () => starts };
}

test('public Headless artifact has no enterprise implementation and its CLI rejects private configuration', async t => {
  const f = await fixture(t), bundle = join(f.root, 'server.mjs');
  const result = await buildHeadlessBundle(bundle);
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.length > 100, 'inspect the real transitive graph');
  assert.deepEqual(inputs.filter(path => path.includes('/enterprise-identity/') || path.includes('products/join/')), []);
  const source = await readFile(bundle, 'utf8');
  assert.ok(!source.includes('TencentOaServerPlugin'));
  const run = promisify(execFile);
  const help = await run(process.execPath, [bundle, '--help'], { timeout: 10_000 });
  assert.match(help.stdout, /human-auth-config/); assert.ok(!help.stdout.includes('enterprise-identity'));
  await assert.rejects(run(process.execPath, [bundle, '--enterprise-identity-token-file', '/not-loaded'], { timeout: 10_000 }), /Unknown option/);
  const api = await import(pathToFileURL(bundle).href);
  const app = await api.startHeadlessServer(f.options); t.after(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 401);
});

test('verified external human identity does not require an enterprise provider name or numeric identifier', async t => {
  const f = await fixture(t);
  let current = true;
  const principal = { provider: 'fixture-directory', subject: 'opaque-human-id', displayName: 'Fixture Human', expiresAt: Date.now() + 60_000 };
  const app = await startHeadlessServer({ ...f.options, accessMemberProviders: [principal.provider] }, {
    createIdentity: async () => ({ providers: [{ authenticate: request => current && request.headers['x-fixture-proof'] === 'verified' ? principal : null }], close() {} }),
  }); t.after(() => app.close());
  const headers = { 'x-fixture-proof': 'verified' };
  const connectorOwner = await (await fetch(app.url + '/__opencraft_connectors')).json();
  assert.deepEqual(Object.keys(connectorOwner.hosts).sort(), ['local-codex', 'opencraft-server']);
  const connectorState = await fetch(app.url + '/__opencraft_connectors', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({hostId:'local-codex',method:'state',params:{}})});
  assert.equal(connectorState.status,200);assert.deepEqual((await connectorState.json()).instances,[]);

  assert.equal((await fetch(app.url)).status, 401);
  const response = await fetch(app.url + '/__opencraft_actors/me', { headers });
  assert.equal(response.status, 200); const first = await response.json(); assert.equal(first.actor.kind, 'human');
  // Exercise the actual assembly: conversation menus use the public Host,
  // which must match the IM list/link and source-query boundary.
  const im = await fetch(app.url + '/__opencraft_im', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({action:'list'})});
  assert.equal(im.status,200);assert.equal((await im.json()).workbenchHostId,'local-codex');
  const foreignSources = await fetch(app.url + '/__opencraft_im', {method:'POST',
    headers:{...headers,origin:app.url,'content-type':'application/json'},body:JSON.stringify({action:'sources',hostId:'other-host',threadId:'thread'})});
  assert.equal(foreignSources.status,400);assert.equal((await foreignSources.json()).error,'unsupported_host');
  current = false;
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers })).status, 401);
  assert.equal((await fetch(app.url, { headers })).status, 401);
});

test('missing or malformed identity fails before execution and rollback releases the data lock', async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, accessMemberProviders: ['fixture'] }), /identity provider/);
  let closed = 0;
  await assert.rejects(startHeadlessServer(f.options, { createIdentity: async () => ({ providers: [{}], close() { closed++; } }) }), /identity adapter/);
  assert.equal(closed, 1); assert.equal(f.starts(), 0);
  const app = await startHeadlessServer(f.options); t.after(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
});

test('public listener accepts explicit membership protection without requiring an anonymous-access acknowledgement', async t => {
  const f = await fixture(t);
  await assert.rejects(startHeadlessServer({ ...f.options, host: '0.0.0.0' }), /unauthenticated-public/);
  assert.equal(f.starts(), 0);
  const app = await startHeadlessServer({ ...f.options, host: '0.0.0.0', accessControl: true }); t.after(() => app.close());
  assert.equal((await fetch(app.url)).status, 401, 'no identity provider or member cannot downgrade to anonymous admission');
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 401);
});

test('local machine ingress proves the socket source and preserves remote and Actor admission', async t => {
  const f = await fixture(t), path = join(f.root, 'local-access');
  await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  const access = await loadLocalMachineAccess(path);
  const request = (host = '127.0.0.1:80', peer = '127.0.0.1', target = '127.0.0.1', extra = {}) => ({
    method: 'GET', url: '/', headers: { host, ...extra }, socket: { remoteAddress: peer, localAddress: target, localPort: 80 },
  });
  const good = request(); assert.equal(access.forward(good), true);
  assert.equal(access.origin(good), 'http://127.0.0.1');
  for (const rejected of [request('127.0.0.1:80', '198.51.100.2'), request('evil.test'),
    request('127.0.0.1:81'), request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { origin: 'https://evil.test' }),
    request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }),
    request('127.0.0.1:80', '127.0.0.1', '127.0.0.1', { 'sec-fetch-site': 'cross-site' })]) {
    rejected.headers['x-opencraft-local-machine-proof'] = good.headers['x-opencraft-local-machine-proof'];
    assert.equal(access.forward(rejected), false); assert.equal(rejected.headers['x-opencraft-local-machine-proof'], undefined);
  }
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (address) { const ip = request(address, address, address); assert.equal(access.forward(ip), true);
    ip.socket.remoteAddress = '127.0.0.1'; assert.equal(access.origin(ip), 'http://' + address); }
  assert.equal(access.origin({ ...good, url: '/different' }), null);
  assert.equal(access.origin({ ...good, socket: { remoteAddress: '198.51.100.2' } }), null);
  await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  assert.equal((await loadLocalMachineAccess(path)).origin(good), null, 'a replacement key retires old proofs');

  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  backend.on('connection', socket => socket.on('message', data => socket.send(data)));
  const app = await startHeadlessServer({ ...f.options, localAccessFile: path, accessControl: true,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:' + backend.address().port, close: async () => {} }),
  }); t.after(() => app.close());
  const current = await loadLocalMachineAccess(path);
  const proofFor = (url, method = 'GET') => { const parsed = new URL(app.url), req = { method, url, headers: { host: parsed.host },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: Number(parsed.port) } };
    assert.equal(current.forward(req), true); return req.headers; };
  assert.equal((await fetch(app.url)).status, 401);
  assert.equal((await fetch(app.url, { headers: proofFor('/') })).status, 200);
  assert.equal((await fetch(app.url + '/__opencraft_actors/me', { headers: proofFor('/__opencraft_actors/me') })).status, 401, 'anonymous workspace is not a human Actor');
  const probe = proofFor('/assets/lazy.js');
  assert.equal((await fetch(app.url + '/__opencraft_access/admission', { headers: { ...probe, 'x-opencraft-relay-probe-method': 'GET', 'x-opencraft-relay-probe-path': '/assets/lazy.js' } })).status, 204);
  assert.equal((await fetch(app.url + '/__opencraft_access/admission', { headers: { ...probe, 'x-opencraft-relay-probe-method': 'POST', 'x-opencraft-relay-probe-path': '/assets/lazy.js' } })).status, 401);
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/appserver', { headers: { ...proofFor('/appserver'), origin: app.url } });
  await once(socket, 'open');
  const reply = once(socket, 'message'); socket.send('local-proof-echo'); assert.equal((await reply)[0].toString(), 'local-proof-echo');
  socket.close(); await once(socket, 'close');
});

test('an identity disposal failure is reported after all owned resources and directory lock are released', async t => {
  const f = await fixture(t); let closes = 0;
  const app = await startHeadlessServer(f.options, { createIdentity: async () => ({ providers: [], close() { closes++; throw new Error('fixture disposal failure'); } }) });
  const first = app.close(), second = app.close(); assert.equal(first, second);
  await assert.rejects(first, AggregateError); assert.equal(closes, 1);
  const replacement = await startHeadlessServer(f.options); t.after(() => replacement.close());
  assert.equal((await fetch(replacement.url)).status, 200);
});
