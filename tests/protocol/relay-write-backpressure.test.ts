import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { closeWhenDone, relayDuplex } from '../../packages/relay-protocol/src/node';

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

function slowSink(received: Buffer[]) {
  return new Duplex({ read() {}, highWaterMark: 16_384, write(chunk: Buffer, _encoding, callback) { received.push(chunk); setTimeout(callback, 1); } });
}

test('a target that closes right after its response still flushes every queued byte to the relay', { timeout: 5000 }, async () => {
  // The target ends and closes at once while the relay side is still draining
  // what was piped into it; tearing it down on close would cut off the tail.
  const source = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const received: Buffer[] = []; const sink = slowSink(received);
  closeWhenDone(source, sink); source.pipe(sink);
  const payload = Buffer.alloc(256 * 1024, 5);
  for (let offset = 0; offset < payload.length; offset += 16_384) source.push(payload.subarray(offset, offset + 16_384));
  source.push(null); source.once('end', () => source.destroy());
  await once(sink, 'finish');
  assert.equal(sink.destroyed, false);
  assert.deepEqual(Buffer.concat(received), payload);
});

test('an aborted target still tears down the relay stream at once', { timeout: 5000 }, async () => {
  const source = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const received: Buffer[] = []; const sink = slowSink(received); sink.on('error', () => {});
  closeWhenDone(source, sink); source.pipe(sink);
  source.push(Buffer.alloc(64 * 1024)); source.destroy();
  await once(sink, 'close');
  assert.equal(sink.writableFinished, false);
});
