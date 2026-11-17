import assert from 'node:assert/strict';
import test from 'node:test';
import {JsonRpcAppServerClient} from '@opencraft/appserver-client';
import {DeferredDuplexTransport, type DuplexTransport, type TransportSendProgressOptions} from '@opencraft/appserver-client/transport';
import {MemoryTransport} from '@opencraft/appserver-transport-memory';
import {RecordingTransport} from '@opencraft/appserver-transport-replay';

test('RPC progress stays local, passes recording/lazy adapters, and ends with its exact pending receipt', async () => {
  let finish!: () => void;
  const memory = new MemoryTransport({server: {receive(frame, peer) {
    const message = JSON.parse(frame);
    if (message.id === undefined) return;
    if (message.method === 'initialize') peer.send(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {userAgent: 'fixture', codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux'}}));
    else finish = () => peer.send(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {acknowledged: true}}));
  }}});
  let observer: TransportSendProgressOptions | undefined;
  const adapter: DuplexTransport = {get status() {return memory.status;},
    connect: signal => memory.connect(signal), close: () => memory.close(),
    subscribeMessage: listener => memory.subscribeMessage(listener), subscribeStatus: listener => memory.subscribeStatus(listener),
    async send(frame, signal, progress) { observer = progress; progress?.onProgress({loaded: 0, total: 10}); await memory.send(frame); },
  };
  const recording = new RecordingTransport({transport: adapter});
  const client = new JsonRpcAppServerClient({hostId: 'progress', transport: new DeferredDuplexTransport(async () => recording)});
  try {
    await client.connect({clientInfo: {name: 'fixture', version: '1'}, capabilities: {experimentalApi: true}});
    const cancelObservation = new AbortController(), values: number[] = [];
    const request = client.requestRaw('fixture/hold', {payload: 'synthetic'}, {sendProgressSignal: cancelObservation.signal, onSendProgress(progress) {
      values.push(progress.loaded); if (progress.loaded === 0) throw new Error('A UI observer cannot cancel admission');
    }});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.getPendingRequestCount(), 1); assert.deepEqual(values, [0]);
    observer!.onProgress({loaded: 1, total: 10}); assert.deepEqual(values, [0, 1]);
    cancelObservation.abort(); observer!.onProgress({loaded: 2, total: 10});
    assert.deepEqual(values, [0, 1]); assert.equal(client.getPendingRequestCount(), 1, 'canceling observation is not a remote cancellation');
    finish(); assert.deepEqual(await request, {acknowledged: true});
    observer!.onProgress({loaded: 10, total: 10}); assert.deepEqual(values, [0, 1]);
    const outgoing = recording.recording.filter(row => row.direction === 'client-to-server').map(row => JSON.parse(row.payload));
    const sent = outgoing.find(row => row.method === 'fixture/hold');
    assert.deepEqual(sent.params, {payload: 'synthetic'});
    assert(!JSON.stringify(sent).includes('onSendProgress')); assert(!JSON.stringify(sent).includes('sendProgressSignal'));
  } finally {await client.close();}
});
