import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import WebSocket, { WebSocketServer } from 'ws';
import { createSshHttpIngress, classifyIngress } from '../../plugins/ssh-http-ingress/src/index.mjs';
import { createProtocolIngress, classifyProtocol } from '../../scripts/web-deployment/protocol-ingress.mjs';
import { createSshNativeRpcGateway } from '../../scripts/ssh-native-rpc-gateway.mjs';
import { AppHostServer } from '../../packages/app-host-server/src/index.ts';

const identity = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { privateKey, publicKey: 'ssh-rsa ' + ssh2.utils.parseKey(privateKey).getPublicSSH().toString('base64') };
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', data => body += data); res.on('end', () => resolve({ code: res.statusCode, body })); });
  req.on('error', reject); req.end();
});

test('dynamic SSH keys retain trusted submission context and retire when their authority is revoked', { timeout: 15_000 }, async () => {
  const host = ssh2.utils.generateKeyPairSync('ed25519'), user = ssh2.utils.generateKeyPairSync('ed25519');
  const contexts = [], listeners = new Set(); let allowed = true;
  const adapter = {
    get status() { return { state: 'open' }; },
    subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); }, subscribeStatus() { return () => {}; },
    async connect() {}, async close() {},
    async send(frame) { const v = JSON.parse(frame); for (const fn of listeners) fn(JSON.stringify({ id: v.id, result: {}, __opencraftClient: v.__opencraftClient })); },
    async sendWithContext(frame, context) { contexts.push(context); await this.send(frame); },
  };
  const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport: () => adapter });
  const native = await createSshNativeRpcGateway(appHost);
  const http = createServer((_req, res) => res.end('legacy'));
  const httpPort = await listen(http);
  const submissionContext = { sender: { kind: 'employee', loginName: 'new.member' } };
  let scoped;
  const ingress = createSshHttpIngress({ hostKey: host.private, authorizedKeys: { legacy: [host.public] }, httpPort, codexPort: native.port,
    resolveAuthorizedKeys: username => allowed && username === 'new.member' ? [user.public] : [],
    authorizeSession: () => ({ submissionContext, isCurrent: () => allowed }),
    createNativeSession: async authorization => scoped = await createSshNativeRpcGateway(appHost, authorization),
  });
  const address = await ingress.listen({ port: 0 });
  const clients = [];
  const connectClient = (username, privateKey = user.private) => {
    const c = new ssh2.Client(); c.on('error', () => {}); clients.push(c);
    const ready = new Promise((resolve, reject) => { c.once('ready', () => resolve(c)); c.once('error', reject); });
    c.connect({ host: '127.0.0.1', port: address.port, username, privateKey, readyTimeout: 1500 }); return ready;
  };
  try {
    await assert.rejects(connectClient('other.member'), /authentication/);
    await assert.rejects(connectClient('new.member', host.private), /authentication/);
    const client = await connectClient('new.member');
    await assert.rejects(new Promise((resolve, reject) => client.exec('opencraft app-server proxy', (error, stream) => error ? reject(error) : resolve(stream))), /Unable to exec/);
    const stream = await new Promise((resolve, reject) => client.exec('codex app-server proxy', (error, channel) => error ? reject(error) : resolve(channel)));
    stream.on('error', () => {});
    const ws = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream });
    ws.on('error', () => {});
    await once(ws, 'open');
    const message = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} })); await message;
    assert.equal(contexts.length, 1); assert.deepEqual(contexts[0], submissionContext);
    const closed = once(client, 'close'); allowed = false; await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
    await assert.rejects(connectClient('new.member'), /authentication/);
  } finally {
    for (const client of clients) client.destroy();
    await ingress.close(); await scoped?.close(); await native.close(); await appHost.close();
    await new Promise(resolve => http.close(resolve));
  }
});

test('protocol classifier preserves fragmented HTTP/SSH boundaries and rejects other protocols', () => {
  for (const classifier of [classifyProtocol, classifyIngress]) {
    for (const text of ['S', 'SS', 'SSH', 'GE', 'OPTI']) assert.equal(classifier(Buffer.from(text)), 'pending');
    assert.equal(classifier(Buffer.from('SSH-2.0-test')), 'ssh');
    assert.equal(classifier(Buffer.from('GET / HTTP/1.1')), 'http');
    assert.equal(classifier(Buffer.from('GEX /')), 'reject');
    assert.equal(classifier(Buffer.from([0x16, 0x03])), 'reject');
  }
});

for (const direct of [false, true]) test(`same public port keeps ${direct ? 'direct' : 'proxied'} Web HTTP/WS separate from authenticated SSH native Host proxy`, { timeout: 30_000 }, async () => {
  const host = identity(), user = identity(), wrong = identity();
  const listeners = new Set(); let status = { state: 'idle' };
  const statuses = new Set();
  const adapter = {
    subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    subscribeStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); },
    get status() { return status; },
    async connect() { status = { state: 'open' }; for (const fn of statuses) fn(status); },
    async close() { status = { state: 'closed' }; for (const fn of statuses) fn(status); },
    async send(frame) { const value = JSON.parse(frame); for (const fn of listeners) fn(JSON.stringify({ id: value.id, result: { echoed: value.method }, __opencraftClient: value.__opencraftClient })); },
  };
  const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport: () => adapter });
  const native = await createSshNativeRpcGateway(appHost, { connectTimeoutMs: 1000 });
  const backendHttp = createServer((_req, res) => res.end('private-headless'));
  const staticHttp = createServer((req, res) => { res.setHeader('x-observed-local-port', String(req.socket.localPort)); res.end('web:' + req.headers['x-forwarded-for']); });
  const webSockets = new WebSocketServer({ server: staticHttp });
  webSockets.on('connection', socket => socket.on('message', data => socket.send('web:' + data)));
  const backendPort = await listen(backendHttp), webPort = await listen(staticHttp);
  const backend = createSshHttpIngress({ hostKey: host.privateKey, authorizedKeys: { fixture: [user.publicKey] }, httpPort: backendPort, codexPort: native.port });
  const backendAddress = await backend.listen({ port: 0 });
  const ingress = createProtocolIngress({ httpPort: webPort, ...(direct ? {httpServer: staticHttp} : {}), sshTarget: `http://127.0.0.1:${backendAddress.port}` });
  const publicAddress = await ingress.listen({ port: 0 });
  const clients = [];
  const ssh = async (key, username = 'fixture') => {
    const client = new ssh2.Client(); clients.push(client);
    const ready = new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); });
    client.connect({ host: '127.0.0.1', port: publicAddress.port, username, privateKey: key, readyTimeout: 1500,
      hostVerifier: value => value.equals(ssh2.utils.parseKey(host.privateKey).getPublicSSH()) });
    await ready; return client;
  };
  try {
    assert.equal((await get(publicAddress.port, '/')).body, 'web:undefined');
    const observedPort = await new Promise((resolve, reject) => {
      const req = request({hostname:'127.0.0.1',port:publicAddress.port,path:'/'}, res => { res.resume();res.once('end',()=>resolve(Number(res.headers['x-observed-local-port']))); });
      req.once('error',reject);req.end();
    });
    assert.equal(observedPort, direct ? publicAddress.port : webPort);
    const publicWs = new WebSocket(`ws://127.0.0.1:${publicAddress.port}/apphost`);
    await once(publicWs, 'open');
    const echoed = once(publicWs, 'message'); publicWs.send('synthetic-frame');
    assert.equal((await echoed)[0].toString(), 'web:synthetic-frame');
    publicWs.terminate();
    // Fragmented protocol bytes and forwarded header are passed unchanged, without adding trusted identity.
    const socket = connect(publicAddress.port, '127.0.0.1'); let response = '';
    socket.on('data', data => response += data);
    await once(socket, 'connect'); socket.write('G'); socket.write('ET / HTTP/1.1\r\nHost: fixture\r\nX-Forwarded-For: synthetic-peer\r\nConnection: close\r\n\r\n');
    await once(socket, 'close'); assert.match(response, /web:synthetic-peer/);
    await assert.rejects(ssh(wrong.privateKey), /authentication/);
    await assert.rejects(ssh(user.privateKey, 'other'), /authentication/);
    const client = await ssh(user.privateKey);
    await assert.rejects(new Promise((resolve, reject) => client.exec('sh', error => error ? reject(error) : resolve())), /Unable to exec/);
    const stream = await new Promise((resolve, reject) => client.exec('codex app-server proxy', (error, channel) => error ? reject(error) : resolve(channel)));
    const ws = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream });
    await once(ws, 'open');
    const message = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
    assert.equal(JSON.parse((await message)[0].toString()).result.echoed, 'initialize');
    ws.terminate();
  } finally {
    for (const client of clients) client.destroy();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise(resolve => webSockets.close(resolve));
    await ingress.close(); await backend.close(); await native.close(); await appHost.close();
    await Promise.all([new Promise(resolve => staticHttp.close(resolve)), new Promise(resolve => backendHttp.close(resolve))]);
  }
});
