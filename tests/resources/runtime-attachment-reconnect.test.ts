import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServerWorkbenchRuntime } from '@opencraft/workbench-runtime';
import type { DuplexTransport, TransportStatus } from '@opencraft/appserver-client';

const tick = () => new Promise<void>(r => setImmediate(r));
const request = { uploadId: 'upload-fixture-1234', clientAttachmentId: 'file', name: 'file', mimeType: 'text/plain', size: 1, offset: 0, dataBase64: 'AQ==', retry: true };
class FixtureTransport implements DuplexTransport {
  status: TransportStatus = { state: 'idle' };
  messages = new Set<(frame: string) => void>();
  statuses = new Set<(status: TransportStatus) => void>();
  uploads = 0;
  connects = 0;
  constructor(public safeReplay = true, readonly opened = Promise.resolve()) {}
  publish(status: TransportStatus) { this.status = status; for (const run of this.statuses) run(status); }
  async connect() { this.connects++; if (this.connects > 1) await this.opened; this.publish({ state: 'open' }); }
  async send(frame: string) {
    const message = JSON.parse(frame);
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === 'initialize') result = { userAgent: 'fixture', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', capabilities: { extensions: { 'opencraft/attachment-staging': { version: 1, sources: ['client-bytes'], locations: ['host-file'], maxBytes: 1024, chunkBytes: 65536, ...(this.safeReplay ? { uploadRetry: 'last-chunk-v1' } : {}) } } } };
    if (message.method === 'attachment/uploadChunk') { this.uploads++; result = { receivedBytes: 1, ref: null }; }
    queueMicrotask(() => { for (const run of this.messages) run(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); });
  }
  subscribeMessage(run: (frame: string) => void) { this.messages.add(run); return () => this.messages.delete(run); }
  subscribeStatus(run: (status: TransportStatus) => void) { this.statuses.add(run); return () => this.statuses.delete(run); }
  async close() { this.publish({ state: 'closed' }); }
}
for (const mode of ['restore', 'downgrade', 'cancel'] as const) test(`upload replay joins shared connection recovery: ${mode}`, async () => {
  let ready!: () => void;
  const first = new FixtureTransport(true, new Promise<void>(resolve => { ready = resolve; }));
  const next = first;
  const runtime = createAppServerWorkbenchRuntime({ hostId: 'upload-fixture', autoReconnect: false, createTransport: () => first });
  try {
    await runtime.connect();
    first.safeReplay = mode !== 'downgrade';
    first.publish({ state: 'failed', reason: 'route lost' });
    await tick();
    const controller = new AbortController();
    const replay = runtime.resources.attachments.uploadChunk(request, undefined, controller.signal);
    const settled = replay.then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 20 && next.connects < 2; i++) await tick();
    assert.equal(next.connects, 2);
    assert.equal(next.uploads, 0, 'no replay before connection authority returns');
    if (mode === 'cancel') controller.abort(new Error('Canceled fixture upload'));
    ready();
    const outcome = await settled;
    if (mode === 'restore') { assert.ok('value' in outcome); assert.equal(next.uploads, 1); }
    else { assert.ok('error' in outcome); assert.equal(next.uploads, 0); }
    await runtime.connect();
    assert.equal(runtime.getSnapshot().phase, 'ready', 'canceling upload leaves shared connection usable');
  } finally { ready(); await runtime.dispose(); }
});

test('upload waits across a transient automatic reconnect failure without bypassing its schedule', async () => {
  let ready!: () => void;
  const transport = new FixtureTransport(true, new Promise<void>(resolve => { ready = resolve; }));
  const connect = transport.connect.bind(transport);
  let attempts = 0;
  transport.connect = async () => {
    if (++attempts === 2) throw new Error('temporary route outage');
    return connect();
  };
  const runtime = createAppServerWorkbenchRuntime({ hostId: 'upload-auto', autoReconnect: true, reconnectDelaysMs: [20], createTransport: () => transport });
  try {
    await runtime.connect();
    transport.publish({ state: 'failed', reason: 'route lost' });
    const replay = runtime.resources.attachments.uploadChunk(request);
    const result = replay.then(value => ({ value }), error => ({ error }));
    await tick();
    assert.equal(attempts, 1, 'upload does not advance the owner retry timer');
    for (let i = 0; i < 100 && attempts < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(attempts, 3);
    assert.equal(transport.uploads, 0);
    ready();
    const outcome = await result;
    assert.ok('value' in outcome, 'the first transient recovery error must not fail the upload');
    assert.equal(transport.uploads, 1);
  } finally { ready(); await runtime.dispose(); }
});
