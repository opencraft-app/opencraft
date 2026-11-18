import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { bridgeRelayDuplex, relayDuplex } from '../../packages/relay-protocol/src/node.js';

test('HTTP response tails survive asynchronous WebSocket writes and release every stream', { timeout: 15_000 }, async t => {
  const payload = Buffer.alloc(514_023);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >>> 8)) & 255;
  const bodies = [payload.subarray(0, 64_355), payload.subarray(0, 70_147), payload, gzipSync(payload)];
  const target = createServer((req, res) => {
    const index = Number(req.url!.slice(1)), body = bodies[index]!;
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'text/css', ...(index === 3 ? { 'content-encoding': 'gzip' } : {}) });
    res.end(body);
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const gateway = createServer(), sockets = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  gateway.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    const stream = relayDuplex(ws), write = stream._write.bind(stream);
    // Model an asynchronous network writer. EOF can arrive while its final
    // write callback is pending even when the whole response fits one frame.
    stream._write = (chunk, encoding, done) => { setTimeout(() => write(chunk, encoding, done), 5); };
    bridgeRelayDuplex(createConnection({ host: '127.0.0.1', port: (target.address() as AddressInfo).port }), stream);
  }));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); gateway.close(); target.closeAllConnections(); target.close(); });
  for (let index = 0; index < bodies.length; index++) {
    await Promise.all(Array.from({ length: 4 }, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, { maxPayload: 65_536, perMessageDeflate: false });
      ws.on('error', () => {}); await once(ws, 'open'); const stream = relayDuplex(ws);
      try {
        const received = await new Promise<Buffer>((resolve, reject) => {
          const req = request({ host: 'target.test', path: '/' + index, headers: { connection: 'close' }, createConnection: () => stream }, response => {
            assert.equal(response.statusCode, 200); const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
            response.once('end', () => { assert.equal(response.complete, true); resolve(Buffer.concat(chunks)); });
          });
          req.on('error', reject); req.end();
        });
        assert.deepEqual(received, bodies[index]);
        if (index === 3) assert.deepEqual(gunzipSync(received), payload);
      } finally { stream.destroy(); ws.terminate(); }
    }));
  }
  const deadline = Date.now() + 2000;
  while (sockets.clients.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.clients.size, 0, 'completed responses must not retain WebSockets');
});

test('raw duplex EOF drains a slow writer; cancellation and truncated input abort both peers', { timeout: 5000 }, async () => {
  const chunks: Buffer[] = [];
  const source = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const destination = new Duplex({ read() {}, write(chunk, _encoding, done) { setTimeout(() => { chunks.push(Buffer.from(chunk)); done(); }, 5); } });
  bridgeRelayDuplex(source, destination);
  source.end(); source.push(Buffer.alloc(70_147, 9)); source.push(null);
  await once(destination, 'finish'); assert.equal(Buffer.concat(chunks).length, 70_147);
  destination.resume(); destination.push(null); await once(destination, 'close');

  const left = new PassThrough(), right = new PassThrough(); bridgeRelayDuplex(left, right);
  left.destroy(); await once(right, 'close'); assert.equal(right.destroyed, true);
  const a = new PassThrough(), b = new PassThrough(), abort = bridgeRelayDuplex(a, b);
  abort(); await Promise.all([once(a, 'close'), once(b, 'close')]); assert.equal(a.destroyed && b.destroyed, true);
  const failed = new PassThrough(), peer = new PassThrough(); bridgeRelayDuplex(failed, peer);
  failed.destroy(new Error('lost transport')); await new Promise<void>(resolve => peer.once('close', resolve)); assert.equal(peer.destroyed, true);
});
