import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { HubNetwork } from '../../packages/hub-network/src/node.js';
import { joinRelayConfiguration } from '../relay-composition.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
const command = (hub: HubNetwork, input: Record<string, unknown>) => hub.command({ revision: hub.snapshot().revision, ...input }, 'fixture');
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= until) throw new Error('Relay fixture did not become ready');
    await sleep(30);
  }
}
function http(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) {
  return new Promise<{ status: number; body: string; cookies: string[] | undefined }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method, headers: options.headers, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, body, cookies: res.headers['set-cookie'] }));
    });
    req.setTimeout(6_000, () => req.destroy(new Error('Relay fixture request timed out')));
    req.once('error', reject);
    req.end(options.body);
  });
}

test('packaged Join Relay preserves signed WeCom callbacks through a real Hub and fails closed after withdrawal', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'join-wecom-relay-'));
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const output = join(dir, 'package');
  await promisify(execFile)(process.execPath, ['relay/package-relay.mjs', output], { cwd: new URL('../../', import.meta.url) });
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const authority = { issuer: 'fixture', publicKey, providers: ['tencentoa'] };
  const origin = 'http://receiver.test';
  const reserve = createServer();
  const port = await listen(reserve);
  await close(reserve);
  const endpoint = 'http://127.0.0.1:' + port;
  const stateFile = join(dir, 'hub.json');
  const seed = new HubNetwork(stateFile, { authority, localService: false });
  const peer = new HubNetwork(join(dir, 'peer.json'), { authority });
  cleanup.push(() => peer.close());
  command(seed, { action: 'configure', name: 'Relay fixture', endpoint, origin: '', accepting: true, forwarding: true });
  const invite = command(seed, { action: 'invite', origins: [origin], allowTransit: false });
  seed.close();
  assert.ok('invitation' in invite && invite.invitation);
  const token = randomBytes(24).toString('hex');
  const encrypted = 'fixture+bytes/=';
  const xml = Buffer.from('<xml>\r\n<Encrypt><![CDATA[' + encrypted + ']]></Encrypt>\r\n</xml>');
  const nonce = 'signed+nonce';
  const timestamp = '1700000000';
  const signature = createHash('sha1').update([token, nonce, timestamp, encrypted].sort().join('')).digest('hex');
  const query = '?nonce=signed%2bnonce&timestamp=' + timestamp + '&msg_signature=' + signature;
  const calls: { path: string; host: string | undefined; headers: Record<string, unknown>; body: Buffer }[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = req.url ?? '';
    calls.push({ path, host: req.headers.host, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(path.endsWith(signature) ? 200 : 401, { 'set-cookie': 'fixture=private' });
    res.end(path.endsWith(signature) ? 'success' : 'rejected');
  });
  const receiverPort = await listen(receiver);
  cleanup.unshift(() => close(receiver));
  peer.start(receiverPort);
  const credential = randomBytes(32).toString('base64url');
  const operatorCredentialFile = join(dir, 'operator.json'), configFile = join(dir, 'relay.json');
  const configuration = { schemaVersion: 1, host: '127.0.0.1', port, routes: [],
    hubNetwork: { stateFile, operatorCredentialFile }, wecomCallback: { hubId: peer.store.id, origin } };
  assert.throws(() => joinRelayConfiguration({ ...configuration, hubNetwork: undefined }), /requires a Relay Hub network/);
  assert.throws(() => joinRelayConfiguration({ ...configuration, wecomCallback: { hubId: peer.store.id, origin: 'http://receiver.test/other' } }));
  let clusterFile: string | undefined;
  if (process.env.OPENCRAFT_REDIS_TEST_FILE) {
    const input = JSON.parse(await readFile(process.env.OPENCRAFT_REDIS_TEST_FILE, 'utf8'));
    const privatePort = createServer();
    const internalPort = await listen(privatePort);
    await close(privatePort);
    clusterFile = join(dir, 'cluster.json');
    await writeFile(clusterFile, JSON.stringify({
      host: input.host, port: input.port, password: input.password, mode: input.mode ?? 'standalone',
      credential: randomBytes(32).toString('base64url'), namespace: 'wecom-fixture-' + randomBytes(16).toString('hex'), internalPort,
    }), { mode: 0o600 });
  }
  await writeFile(operatorCredentialFile, JSON.stringify({ credential }), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ ...configuration, clusterFile }), { mode: 0o600 });
  const child = spawn(process.execPath, [join(output, 'relay.mjs'), configFile], {
    env: { ...process.env, OPENCRAFT_GRASP_UPSTREAM: '',
      OPENCRAFT_RELAY_NODE_ID: 'wecom-fixture', OPENCRAFT_RELAY_ADVERTISE_HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await waitFor(async () => (await http(port, '/__opencraft_relay/health').catch(() => null))?.status === 200);
  const send = (path: string, method = 'POST') => http(port, path, {
    method, body: xml, headers: { 'content-type': 'application/xml', 'content-length': String(xml.length),
      cookie: 'browser=private', authorization: 'Bearer fixture', 'x-forwarded-for': '192.0.2.1' },
  });
  assert.equal((await send('/wecom_callback' + query)).status, 503);
  command(peer, { action: 'connect', invitation: invite.invitation, trustIdentity: true, publishOrigin: origin });
  await waitFor(async () => {
    const reply = await http(port, '/__opencraft_hub/operator', { headers: { authorization: 'Bearer ' + credential } });
    return JSON.parse(reply.body).routes.some((route: { hubId: string }) => route.hubId === peer.store.id);
  });
  assert.deepEqual(await send('/wecom_callback' + query), { status: 200, body: 'success', cookies: undefined });
  assert.equal((await send('/wecom_callback' + query.replace(signature, '0'.repeat(40)))).status, 401);
  assert.equal((await send('/wecom_callback/other' + query)).status, 403);
  assert.equal((await send('/wecom_callback' + query, 'GET')).status, 403);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.path, '/__opencraft_im/shadow-callback/wecom' + query);
  assert.equal(calls[0]!.host, 'receiver.test');
  assert.deepEqual(calls[0]!.body, xml);
  for (const header of ['cookie', 'authorization', 'x-forwarded-for']) assert.equal(calls[0]!.headers[header], undefined);
  peer.close();
  assert.equal((await send('/wecom_callback' + query)).status, 503);
  assert.equal(calls.length, 2);
});
