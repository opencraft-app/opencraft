import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { ownerProbeRpc } from '../../scripts/smoke/execution/owner-probe-rpc.mjs';
import { DshConsumerReceipts } from '../../scripts/server-deployment/dsh-consumer-receipts.mjs';

test('direct initialize/list, error and late response ACK every consumed receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-probe-'));
  await mkdir(join(root, 'ledger'));
  const receipts = new DshConsumerReceipts(join(root, 'ledger'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  let acknowledgments = 0, sendLate;
  server.on('connection', peer => peer.on('message', raw => {
    const request = JSON.parse(String(raw));
    if (request.method === 'opencraft/owner/receipt') {
      receipts.acknowledge(request.params); acknowledgments++; return;
    }
    const finish = receipts.begin(request);
    const packet = request.method === 'error' ? { id: request.id, error: { code: -1 } }
      : { id: request.id, result: { data: [] } };
    const send = () => peer.send(JSON.stringify({ ...packet, opencraftDshReceipt: finish(packet) }));
    if (request.method === 'late') sendLate = send; else send();
  }));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(socket, 'open');
  t.after(() => socket.terminate());
  const rpc = ownerProbeRpc(socket, { timeoutMs: 1000 });
  await rpc('initialize', {}); await rpc('thread/list', { limit: 1 });
  await assert.rejects(rpc('error'), /rejected/);
  await assert.rejects(rpc('late'), /timeout/);
  assert.equal(typeof sendLate, 'function'); sendLate();
  for (let i = 0; i < 100 && acknowledgments < 4; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(acknowledgments, 4);
  assert.deepEqual(receipts.observation(), { coverage: 'complete', activeCount: 0 });
  socket.close(); await once(socket, 'close');
});
