import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { connectRelay } from '../../plugins/relay-connect/src/server';
import { CONTROL_PATH, DATA_PATH, MAX_RELAY_STREAMS, STREAM_HEADER } from '../../packages/relay-protocol/src';

async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Relay fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('relay saturation preserves its control and live streams, then admits opens after release', async t => {
  const targets = new Set<import('node:net').Socket>();
  const target = createTcpServer(socket => {
    targets.add(socket); socket.once('close', () => targets.delete(socket));
    socket.pipe(socket);
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const server = createServer(), sockets = new WebSocketServer({ noServer: true });
  const data = new Map<string, WebSocket>();
  let control: WebSocket | undefined;
  let controlConnections = 0;
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, ws => {
      if (request.url === CONTROL_PATH) { control = ws; controlConnections++; }
      else if (request.url === DATA_PATH) {
        const id = String(request.headers[STREAM_HEADER]);
        data.set(id, ws); ws.once('close', () => data.delete(id));
      } else ws.terminate();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connectRelay({ relay: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    credential: randomBytes(32).toString('base64url'),
    targetPort: (target.address() as import('node:net').AddressInfo).port, allowLoopbackInsecure: true });
  t.after(async () => {
    client.close(); for (const ws of sockets.clients) ws.terminate();
    for (const socket of targets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => target.close(() => resolve()))]); sockets.close();
  });
  await waitFor(() => !!control && client.connected());
  const open = () => {
    const id = randomUUID();
    control!.send(JSON.stringify({ type: 'open', id, token: randomBytes(32).toString('base64url') }));
    return id;
  };
  for (let i = 0; i < MAX_RELAY_STREAMS; i++) open();
  await waitFor(() => data.size === MAX_RELAY_STREAMS && targets.size === MAX_RELAY_STREAMS);
  const existingControl = control!;
  const overflow = open();
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(existingControl.readyState, WebSocket.OPEN, 'capacity is not a protocol violation');
  assert.equal(controlConnections, 1, 'no hidden control reconnect');
  assert.equal(data.size, MAX_RELAY_STREAMS, 'stream budget stays bounded');
  assert.equal(data.has(overflow), false, 'only the excess open is rejected');
  const survivor = data.values().next().value!;
  const echoed = once(survivor, 'message'); survivor.send('still connected');
  assert.equal(String((await echoed)[0]), 'still connected', 'existing traffic still flows');
  survivor.terminate();
  await waitFor(() => data.size === MAX_RELAY_STREAMS - 1 && targets.size === MAX_RELAY_STREAMS - 1);
  const replacement = open(); await waitFor(() => data.has(replacement));
  assert.equal(existingControl.readyState, WebSocket.OPEN);
  const closed = once(existingControl, 'close');
  existingControl.send('{invalid');
  assert.equal((await closed)[0], 1008, 'malformed control still fails closed, including at capacity');
});
