import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { connectRelay } from '../../plugins/relay-connect/src/server.js';
import { createRelayServer } from '../../apps/relay-server/src/server.js';
import { AssertionSigner } from '../../packages/identity-core/src/node.js';
import { CONTROL_PATH, DATA_PATH, STREAM_HEADER, RELAY_PROTOCOL, DRAIN_HEADER, DRAIN_CAPABILITY } from '../../packages/relay-protocol/src/index.js';
import { relayDuplex, bridgeRelayDuplex } from '../../packages/relay-protocol/src/node.js';
import { createConnection } from 'node:net';

const token = () => randomBytes(32).toString('base64url');
const port = (server: Server | ReturnType<typeof createTcpServer>) => (server.address() as AddressInfo).port;
const base = (server: Server) => `http://127.0.0.1:${port(server)}`;
async function listen(server: Server | ReturnType<typeof createTcpServer>) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await new Promise(r => setTimeout(r, 10)); }
}
function get(url: string, headers: Record<string, string> = {}, received?: () => void) {
  return new Promise<{status: number; body: Buffer; headers: IncomingHttpHeaders}>((resolve, reject) => {
    request(url, { agent: false, headers }, res => {
      const chunks: Buffer[] = []; res.on('data', c => { chunks.push(c); received?.(); }); res.on('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    }).on('error', reject).end();
  });
}

for (const negotiated of [false, true]) test(`connector with ${negotiated ? 'stream-preserving' : 'legacy'} relay: reconnect, data lifetime and policy rejection`, { timeout: 10000 }, async t => {
  const targets = new Set<Socket>();
  const target = createTcpServer(socket => { targets.add(socket); socket.once('close', () => targets.delete(socket)); socket.pipe(socket); });
  await listen(target);
  const server = createServer(), wss = new WebSocketServer({ noServer: true });
  if (negotiated) wss.on('headers', (headers, req) => { if (req.url === CONTROL_PATH) headers.push(`${DRAIN_HEADER}: ${DRAIN_CAPABILITY}`); });
  const controls: WebSocket[] = [], data = new Map<string, WebSocket>();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    if (req.url === CONTROL_PATH) controls.push(ws);
    else { const id = String(req.headers[STREAM_HEADER]); data.set(id, ws); ws.once('close', () => data.delete(id)); }
  }));
  await listen(server);
  const client = connectRelay({ relay: base(server), credential: token(), targetPort: port(target), allowLoopbackInsecure: true });
  t.after(() => { client.close(); for (const ws of wss.clients) ws.terminate(); for (const socket of targets) socket.destroy(); server.closeAllConnections(); server.close(); target.close(); wss.close(); });
  await until(() => controls.length === 1 && client.connected());
  const id = randomUUID(); controls[0]!.send(JSON.stringify({ type: 'open', id, token: token() }));
  await until(() => data.has(id) && targets.size === 1);
  const original = data.get(id)!;
  controls[0]!.terminate();
  await until(() => controls.length === 2 && client.connected());
  if (negotiated) {
    const reply = once(original, 'message'); original.send('after control reconnect');
    assert.equal(String((await reply)[0]), 'after control reconnect');
    controls[1]!.close(1008, 'Policy revoked');
  }
  await until(() => data.size === 0 && targets.size === 0);
});
