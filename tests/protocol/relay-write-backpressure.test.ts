import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { relayDuplex } from '../../packages/relay-protocol/src/node';

test('a giant relay write becomes bounded complete messages with identical byte order', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const accepted = once(server, 'connection');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`); await once(client, 'open');
  const [peer] = await accepted; const stream = relayDuplex(peer);
  stream.on('error', () => {});
  t.after(() => { stream.destroy(); client.terminate(); peer.terminate(); server.close(); });
  const chunks: Buffer[] = []; const payload = Buffer.alloc(1024 * 1024 + 13, 123);
  const received = new Promise<void>(resolve => {
    let bytes = 0; client.on('message', data => { const chunk = Buffer.from(data as Buffer); chunks.push(chunk); bytes += chunk.length; if (bytes === payload.length) resolve(); });
  });
  assert.equal(stream.write(payload), false, 'writable applies backpressure');
  await received;
  assert.ok(chunks.length > 1); assert.ok(chunks.every(chunk => chunk.length <= 16_384));
  assert.deepEqual(Buffer.concat(chunks), payload);
});
