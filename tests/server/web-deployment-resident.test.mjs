import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createServer as tcpServer, createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createManagedWebServer } from '../../scripts/web-deployment/server.mjs';
import { packageWebServer } from '../../scripts/package-web-server.mjs';
import { createResidentEntry, residentRequest } from '../../scripts/web-deployment/resident-entry.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { try { const value = await read(); if (predicate(value)) return value; } catch {} await sleep(20); } while (Date.now() < deadline);
  throw new Error('Resident fixture did not reach expected state');
}
function http(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((accept, reject) => {
    const req = request(url, { method, headers, agent: false }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => accept({ status: res.statusCode, headers: res.headers, body })); res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
async function connect(url) { const socket = new WebSocket(url); socket.on('error', () => {}); await once(socket, 'open'); return socket; }
async function echo(socket, value) { const received = once(socket, 'message'); socket.send(value); assert.equal(String((await received)[0]), value); }

test('real packaged entry hands off authority while original WS, SSH and HTTP survive', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-resident-'));
  const stateDirectory = join(root, 'state');
  const policyCalls = [];
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/__opencraft_model_policy') {
      policyCalls.push({ method: req.method, authorization: req.headers.authorization, origin: req.headers.origin });
      if (req.headers.authorization !== 'Bearer fixture-admin') { res.writeHead(403); res.end('{"error":"administrator_required"}'); return; }
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => res.end(JSON.stringify({ canManage: true, ...(body ? JSON.parse(body) : { revision: 0, rules: [] }) })));
      return;
    }
    res.end('{"ok":true}');
  });
  const relay = createServer((req, res) => {
    if (req.url === '/slow') { res.writeHead(200); res.write('before-'); slowResponse = res; }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('relay'); }
  });
  const wsBackend = new WebSocketServer({ noServer: true });
  const messages = [], sshPeers = new Set();
  for (const server of [backend, relay]) server.on('upgrade', (req, socket, head) => {
    wsBackend.handleUpgrade(req, socket, head, ws => wsBackend.emit('connection', ws, req));
  });
  wsBackend.on('connection', socket => socket.on('message', data => { messages.push(String(data)); socket.send(data); }));
  const ssh = tcpServer(socket => { sshPeers.add(socket); socket.once('close', () => sshPeers.delete(socket)); socket.pipe(socket); });
  let app, slowResponse, sshClient, oldSockets = [], newSocket;
  try {
    await Promise.all([backend, relay, ssh].map(server => new Promise(done => server.listen(0, '127.0.0.1', done))));
    const webRoot = join(root, 'web'); await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<html><head><meta name="opencraft-build-id" content="resident-fixture"></head><body>fixture</body></html>');
    await writeFile(join(webRoot, 'version.json'), JSON.stringify({ buildId: 'resident-fixture' }));
    const packed = await packageWebServer({ version: '1.0.0', webRoot, output: join(root, 'package') });
    const workerPath = join(packed.packageRoot, 'runtime/worker.mjs');
    await writeFile(workerPath, 'await new Promise(done => setTimeout(done, 700));\n' + await readFile(workerPath, 'utf8'));
    const inspectionState = join(root, 'inspection-state');
    let applied = 0, inspected = 0;
    const execution = { apply: async () => { applied++; }, inspect: async () => { inspected++; },
      status: async () => ({ ready: true, version: '1.0.0', buildId: 'resident-fixture' }) };
    const inspection = await createManagedWebServer({ initialRelease: packed.packageRoot,
      stateDirectory: inspectionState, execution, reconcileExecutionOnStartup: false });
    await inspection.close(); assert.equal(applied, 0); assert.equal(inspected, 1);
    execution.status = async () => ({ ready: true, version: '0.0.0', buildId: 'changed' });
    await assert.rejects(createManagedWebServer({ initialRelease: packed.packageRoot,
      stateDirectory: inspectionState, execution, reconcileExecutionOnStartup: false }), /changed during entry handoff/);
    assert.equal(applied, 0);
    const entry = join(packed.packageRoot, 'runtime/cli.mjs');
    const nextDirectory = join(root, 'next'); await mkdir(nextDirectory);
    const next = join(nextDirectory, 'cli.mjs'); await cp(entry, next);
    const environment = { PATH: process.env.PATH, OPENCRAFT_WEB_RELEASE: packed.packageRoot,
      OPENCRAFT_HEADLESS_BACKEND_URL: `http://127.0.0.1:${backend.address().port}`,
      OPENCRAFT_RELAY_INGRESS_URL: `http://127.0.0.1:${relay.address().port}`,
      OPENCRAFT_RELAY_INTERNAL_PORT: '0', OPENCRAFT_HEADLESS_SSH_TARGET: `http://127.0.0.1:${ssh.address().port}` };
    const options = { entry, stateDirectory, port: 0, internalPort: 0, environment, maxPendingSockets: 2, maxRetired: 2, startupTimeoutMs: 10000 };
    app = await createResidentEntry(options);
    const base = `http://127.0.0.1:${app.status().publicAddress.port}`;
    const internal = `http://127.0.0.1:${app.status().internalAddress.port}`;
    assert.equal((await stat(app.controlPath)).mode & 0o777, 0o600);
    await assert.rejects(createResidentEntry(options), /already running/);
    assert.equal((await residentRequest(app.controlPath, { action: 'status' })).pid, process.pid);
    assert.equal((await http(base + '/version.json')).status, 200);
    assert.equal((await http(internal + '/version.json')).status, 200);
    async function checkModelPolicy() {
      const before = policyCalls.length;
      const admin = { authorization: 'Bearer fixture-admin', origin: internal, 'content-type': 'application/json' };
      const read = await http(internal + '/__opencraft_model_policy', { headers: admin });
      assert.equal(read.status, 200); assert.equal(JSON.parse(read.body).canManage, true);
      const body = JSON.stringify({ revision: 0, rules: [{ engine: 'codex', effort: 'ultra' }] });
      const saved = await http(internal + '/__opencraft_model_policy', { method: 'POST', headers: admin, body });
      assert.equal(saved.status, 200); assert.deepEqual(JSON.parse(saved.body).rules, JSON.parse(body).rules);
      for (const method of ['GET', 'POST']) {
        const denied = await http(internal + '/__opencraft_model_policy', { method, headers: { authorization: 'Bearer fixture-member' } });
        assert.equal(denied.status, 403); assert.equal(JSON.parse(denied.body).error, 'administrator_required');
      }
      assert.equal(policyCalls.length - before, 4, 'each policy request reaches its owner exactly once');
      assert.deepEqual(policyCalls.slice(before, before + 2), ['GET', 'POST'].map(method => ({ method, authorization: admin.authorization, origin: internal })));
    }
    await checkModelPolicy();
    oldSockets = await Promise.all(['/apphost', '/appserver'].map(path => connect(base.replace('http:', 'ws:') + path)));
    let closes = 0; for (const socket of oldSockets) socket.on('close', () => { closes++; });
    await Promise.all(oldSockets.map((socket, i) => echo(socket, 'before-' + i)));
    sshClient = createConnection({ host: '127.0.0.1', port: app.status().publicAddress.port }); sshClient.on('error', () => {});
    await once(sshClient, 'connect');
    let sshData = once(sshClient, 'data'); sshClient.write('SSH-2.0-fixture\r\n'); assert.equal(String((await sshData)[0]), 'SSH-2.0-fixture\r\n');
    let slowPrefix;
    const prefix = new Promise(done => { slowPrefix = done; });
    const slow = new Promise((accept, reject) => {
      const req = request(base + '/slow', { agent: false }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; slowPrefix(); }); res.on('end', () => accept(body)); res.on('error', reject);
      }); req.on('error', reject); req.end();
    });
    await prefix;
    const key = (await readFile(join(stateDirectory, 'admin-key'), 'utf8')).trim();
    const loginBody = JSON.stringify({ key });
    const login = request(base + '/__opencraft_updates/login', { method: 'POST', agent: false,
      headers: { origin: base, 'content-type': 'application/json', expect: '100-continue', 'content-length': Buffer.byteLength(loginBody) } });
    login.on('error', () => {}); const continued = once(login, 'continue'); login.flushHeaders(); await continued;
    const originalPid = app.status().activePid;
    await assert.rejects(app.reload(next), /entry-busy/);
    assert.equal(app.status().activePid, originalPid);
    const loginResponse = once(login, 'response'); login.end(loginBody);
    const [loggedIn] = await loginResponse; loggedIn.resume(); await once(loggedIn, 'end'); assert.equal(loggedIn.statusCode, 200);
    const cookie = loggedIn.headers['set-cookie'][0].split(';')[0];
    const badDirectory = join(root, 'bad'); await mkdir(badDirectory); const bad = join(badDirectory, 'cli.mjs');
    await writeFile(bad, 'process.exit(1);');
    await assert.rejects(app.reload(bad)); assert.equal(app.status().activePid, originalPid);
    const swapping = app.reload(next);
    await until(() => app.status(), s => s.activePid === null);
    const queued = http(base + '/version.json');
    await until(() => app.status(), s => s.pending === 1);
    const queuedSocket = new WebSocket(base.replace('http:', 'ws:') + '/appserver'); queuedSocket.on('error', () => {});
    const opened = once(queuedSocket, 'open');
    await until(() => app.status(), s => s.pending === 2);
    const excess = createConnection({ host: '127.0.0.1', port: app.status().publicAddress.port }); excess.on('error', () => {});
    await once(excess, 'close');
    await swapping;
    assert.notEqual(app.status().activePid, originalPid);
    await checkModelPolicy();
    assert.equal((await queued).status, 200); await opened; newSocket = queuedSocket;
    assert.equal(closes, 0);
    await Promise.all(oldSockets.map((socket, i) => echo(socket, 'after-' + i))); await echo(newSocket, 'queued-once');
    assert.equal(messages.filter(s => s === 'queued-once').length, 1);
    sshData = once(sshClient, 'data'); sshClient.write('still-connected'); assert.equal(String((await sshData)[0]), 'still-connected');
    slowResponse.end('after'); assert.equal(await slow, 'before-after');
    assert.equal(JSON.parse((await http(base + '/__opencraft_updates', { headers: { cookie } })).body).authenticated, true);
    const failingDirectory = join(root, 'fails-activation'); await mkdir(failingDirectory); const fails = join(failingDirectory, 'cli.mjs');
    await writeFile(fails, `process.on('message', m => { if(m.command==='activate')process.exit(1); }); process.send({protocol:1,event:'prepared'});`);
    await assert.rejects(app.reload(fails));
    assert.equal((await http(base + '/version.json')).status, 200);
    await Promise.all(oldSockets.map((socket, i) => echo(socket, 'fallback-' + i))); await echo(newSocket, 'fallback-new');
    assert.equal(closes, 0);
    assert.equal(JSON.parse((await http(base + '/__opencraft_updates', { headers: { cookie } })).body).authenticated, true);
    await assert.rejects(app.reload(next), /retired-generation-limit/);
    for (const socket of [...oldSockets, newSocket]) socket.close(); sshClient.end();
    await until(() => app.status(), s => s.generations.length === 1);
    const claims = await readdir(join(stateDirectory, 'deployment-lock'));
    assert.equal(claims.length, 1); assert.ok(claims[0].startsWith(app.status().activePid + '-'));
    const crashedPid = app.status().activePid; process.kill(crashedPid, 'SIGKILL');
    await until(() => app.status(), s => s.activePid && s.activePid !== crashedPid);
    assert.equal((await http(base + '/version.json')).status, 200);
    await app.close(); app = await createResidentEntry(options);
    assert.equal(app.status().entry, next, 'the accepted fixed entry survives resident restart');
    const fresh = `http://127.0.0.1:${app.status().publicAddress.port}`;
    assert.equal((await http(fresh + '/version.json')).status, 200);
  } finally {
    for (const socket of [...oldSockets, newSocket].filter(Boolean)) socket.terminate(); sshClient?.destroy();
    slowResponse?.end(); await app?.close();
    for (const socket of wsBackend.clients) socket.terminate(); await new Promise(done => wsBackend.close(done));
    for (const socket of sshPeers) socket.destroy();
    for (const server of [backend, relay]) server.closeAllConnections();
    await Promise.all([backend, relay, ssh].map(server => new Promise(done => server.close(done))));
    await rm(root, { recursive: true, force: true });
  }
});

test('original socket addresses survive IPC, queued sockets expire, missing selection fails closed', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-resident-peer-'));
  const entry = join(root, 'cli.mjs'), stateDirectory = join(root, 'state');
  await writeFile(entry, `process.on('message', (m,s) => {
    if(m.command==='activate')setTimeout(()=>process.send({protocol:1,id:m.id,ok:true}),200);
    if(m.command==='deactivate')process.send({protocol:1,id:m.id,ok:true,value:null});
    if(m.command==='drain')process.exit(0);
    if(m.command==='socket')s.end(JSON.stringify({remoteAddress:s.remoteAddress,remotePort:s.remotePort,localAddress:s.localAddress,localPort:s.localPort}));
  });process.send({protocol:1,event:'prepared'});`);
  let app;
  try {
    app = await createResidentEntry({ entry, stateDirectory, port: 0, pendingTimeoutMs: 40 });
    const client = createConnection({ host: '127.0.0.1', port: app.status().publicAddress.port, localAddress: '127.0.0.2' });
    client.on('error', () => {}); await once(client, 'connect');
    const expected = { remoteAddress: client.localAddress, remotePort: client.localPort, localAddress: client.remoteAddress, localPort: client.remotePort };
    let data = ''; client.on('data', chunk => { data += chunk; }); await once(client, 'end'); client.destroy();
    assert.deepEqual(JSON.parse(data), expected);
    const reload = app.reload(entry); await until(() => app.status(), s => s.activePid === null);
    const waiting = createConnection({ host: '127.0.0.1', port: app.status().publicAddress.port }); waiting.on('error', () => {});
    let received = false; waiting.on('data', () => { received = true; }); await once(waiting, 'close');
    assert.equal(received, false); assert.equal(app.status().pending, 0); await reload;
    await app.close();
    await rm(entry);
    const fallbackDirectory = join(root, 'fallback'); await mkdir(fallbackDirectory);
    const fallback = join(fallbackDirectory, 'cli.mjs'); await writeFile(fallback, 'process.exit(1)');
    await assert.rejects(createResidentEntry({ entry: fallback, stateDirectory, port: 0 }), { code: 'ENOENT' });
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
