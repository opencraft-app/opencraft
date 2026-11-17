import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveBrowserAttachmentForHost} from '../../apps/workbench-web/src/runtime/browser-attachment-resolver';
import type {AppServerWorkbenchRuntime} from '@opencraft/workbench-runtime';

for (const successor of [false, true]) test(`final receipt after Draft cancellation cleans only its original Host generation: successor=${successor}`, async () => {
  let generation = 1, receive!: (result: unknown) => void;
  const removed: string[] = [], listeners = new Set<() => void>();
  const signal = new AbortController();
  const host = {
    getSnapshot: () => ({phase: 'ready', transport: {state: 'open'}, hostId: 'fixture', connectionGeneration: generation}),
    subscribe: (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);},
    resources: {attachments: {
      capabilities: () => ({version: 1, sources: ['client-bytes'], locations: ['host-file'], maxBytes: 100, chunkBytes: 32, uploadRetry: 'last-chunk-v1'}),
      uploadChunk: () => new Promise(resolve => {receive = resolve;}), uploadCancel: async () => ({removed: false}),
      stage: async () => {throw new Error('Chunk path required');},
      remove: async (id: string) => {removed.push(id); return {removed: true};},
    }},
  } as unknown as AppServerWorkbenchRuntime;
  const file = new File(['a'], 'one.txt', {type: 'text/plain'});
  const result = resolveBrowserAttachmentForHost(host, file,
    {id: 'attachment', name: file.name, mimeType: file.type, size: file.size, lifecycle: 'pending', uri: null, error: null}, undefined, signal.signal);
  const rejected = assert.rejects(result, /Draft removed/);
  await new Promise(resolve => setImmediate(resolve));
  signal.abort(new Error('Draft removed'));
  if (successor) {generation++; for (const listener of listeners) listener();}
  receive({receivedBytes: 1, ref: {id: 'proved-ref', name: file.name, mimeType: file.type, size: 1, location: {kind: 'host-file', path: '/synthetic/one.txt'}}});
  await rejected;
  assert.deepEqual(removed, successor ? [] : ['proved-ref']);
  assert.equal(listeners.size, 0);
});
