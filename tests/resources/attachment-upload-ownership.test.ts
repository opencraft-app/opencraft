import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttachmentUploadStore} from '../../apps/local-agent-host/src/attachments/attachment-upload-store';
import {AttachmentChunkDeadline} from '../../packages/appserver-client/src/attachment-chunk-deadline';
import {parseAttachmentStagingCapability} from '@opencraft/appserver-protocol';

const first = {uploadId: 'upload-owner-fixture-1234', clientAttachmentId: 'one', name: 'one.txt', mimeType: 'text/plain', size: 2, offset: 0, dataBase64: 'AQ=='};
const ref = {id: 'committed', name: 'one.txt', mimeType: 'text/plain', size: 2, location: {kind: 'host-file' as const, path: '/synthetic/one.txt'}};

test('concurrent identical chunk replay commits each byte once and final replay returns one ref', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upload-owner-')); let commits = 0;
  const store = new AttachmentUploadStore(root, async () => { commits++; return {ref}; });
  t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
  const initial = await Promise.all([store.chunk(first), store.chunk({...first, retry: true})]);
  assert.deepEqual(initial, [{receivedBytes: 1, ref: null}, {receivedBytes: 1, ref: null}]);
  const last = {...first, offset: 1, dataBase64: 'Ag=='};
  const final = await Promise.all([store.chunk(last), store.chunk({...last, retry: true})]);
  assert.equal(commits, 1); assert.deepEqual(final[0], final[1]); assert.deepEqual(final[0].ref, ref);
  for (const mutation of [{dataBase64: 'Aw=='}, {name: 'changed.txt'}, {clientAttachmentId: 'different'}, {size: 3}, {offset: 0}]) {
    await assert.rejects(store.chunk({...last, ...mutation, retry: true}), /does not match/);
  }
  assert.equal(commits, 1);
});

test('expired final receipt and fresh Host cannot recreate an ambiguous committed upload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upload-expiry-')); let now = Date.now(), commits = 0;
  t.mock.method(Date, 'now', () => now);
  const make = () => new AttachmentUploadStore(root, async () => {commits++; return {ref};});
  const old = make(); const one = {...first, size: 1};
  t.after(async () => {await old.close(); await rm(root, {recursive: true, force: true});});
  await old.chunk(one); assert.equal(commits, 1);
  now += 10 * 60_000 + 1;
  await assert.rejects(old.chunk({...one, retry: true}), /expired or is unavailable/);
  await old.close(); const successor = make();
  try { await assert.rejects(successor.chunk({...one, retry: true}), /expired or is unavailable/); }
  finally {await successor.close();}
  assert.equal(commits, 1);
});

test('cancelled partial upload cannot be revived by a retry flag', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upload-cancel-'));
  const store = new AttachmentUploadStore(root, async () => {throw new Error('No commit allowed');});
  t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
  await store.chunk(first); assert.deepEqual(await store.cancel(first.uploadId), {removed: true});
  await assert.rejects(store.chunk({...first, retry: true}), /expired or is unavailable/);
});

test('unknown replay capability does not authorize retry', () => {
  const base = {version: 1, sources: ['client-bytes'], locations: ['host-file'], maxBytes: 100, chunkBytes: 32};
  assert.equal(parseAttachmentStagingCapability({...base, uploadRetry: 'future-unsafe-replay'}).uploadRetry, undefined);
  assert.equal(parseAttachmentStagingCapability({...base, uploadRetry: 'last-chunk-v1'}).uploadRetry, 'last-chunk-v1');
});

test('invalid progress cannot shorten the chunk deadline; dispose is terminal for late observations', () => {
  const timers = new Map<number, {run(): void; ms: number}>(); let serial = 0;
  const clock = {setTimeout(run: () => void, ms: number) {const id = ++serial; timers.set(id, {run, ms}); return id;}, clearTimeout(id: unknown) {timers.delete(id as number);}};
  const deadline = new AttachmentChunkDeadline(1000, false, clock);
  const initial = [...timers.entries()];
  for (const progress of [{loaded: NaN, total: 1}, {loaded: Infinity, total: 1}, {loaded: 1, total: Infinity}, {loaded: -1, total: 10}, {loaded: 11, total: 10}, {loaded: 0, total: 0}]) deadline.observe(progress);
  assert.deepEqual([...timers.entries()], initial);
  deadline.observe({loaded: 1, total: 10}); assert.equal([...timers.values()][0]!.ms, 10 * 60_000);
  deadline.dispose(); deadline.observe({loaded: 10, total: 10}); assert.equal(timers.size, 0); assert.equal(deadline.signal.aborted, false);
});
