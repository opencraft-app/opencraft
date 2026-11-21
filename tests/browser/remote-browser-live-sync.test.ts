import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';

const tab = (id: string, extra: Record<string, unknown> = {}) => ({ id, pageId: 'p-' + id, ownerId: 'owner', createdAt: 1, viewportMode: 'responsive', ...extra });
const sleep = async (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** Two Web clients against one real Browser service. Sockets are routed to the
 * service and the service's push fan-out is delivered like the live gateway. */
async function harness(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-live-sync-'));
  const service = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
  const owners: RemoteBrowserStorage[] = [];
  const saved = new Map(['WebSocket', 'location', 'localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  class Socket {
    static OPEN = 1; readyState = 0; onopen?: () => void; onmessage?: (event: any) => void; onclose?: () => void; onerror?: () => void;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    push(value: any) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
    async send(bytes: string) {
      const message = JSON.parse(bytes);
      // Server fan-out reuses the socket transport; deliver pushes verbatim.
      if (message.type) { this.push(message); return; }
      service.metadataObservers.set(this, { ownerId: 'owner', authorize: () => {} });
      try {
        const value = message.method === 'metadata-digest'
          ? await service.metadataDigest('owner', message.input, () => {})
          : message.method === 'state'
            ? await service.metadata('owner', message.input, () => {}, this)
            : await service.metadata('owner', message.input, () => {}, this);
        this.push({ type: 'result', id: message.id, value });
      } catch (error: any) {
        this.push({ type: 'result', id: message.id, error: { code: error.code ?? 'BROWSER_ERROR', message: error.message } });
      }
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://fixture.test/' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  t.after(async () => {
    for (const owner of owners) owner.dispose();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    service.close(); await service.persistence; await rm(directory, { recursive: true, force: true });
  });
  const open = async () => { const owner = await RemoteBrowserStorage.create(); owners.push(owner); return owner; };
  return { service, open };
}

test('a tab committed on one device reaches the other without a reload', async t => {
  const { open } = await harness(t);
  const a = await open(), b = await open();
  assert.equal(a.getItem('opencraft.browser-tabs.v1'), null);
  const changes: string[] = [];
  b.onMetadataChanged(field => changes.push(field));
  a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1')]));
  await a.flush();
  await sleep(200);
  assert.deepEqual(changes, ['tabs']);
  assert.deepEqual(JSON.parse(b.getItem('opencraft.browser-tabs.v1')!), [tab('t1')]);
});

test('a close on one device beats a stale edit elsewhere and both converge', async t => {
  const { open } = await harness(t);
  const a = await open(), b = await open();
  a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1'), tab('t2')]));
  await a.flush(); await sleep(200);
  // b edits t1's viewport from its last acknowledged base, a closes t2.
  b.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1', { viewportMode: 'mobile' }), tab('t2')]));
  a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1')]));
  await Promise.all([a.flush(), b.flush()]);
  await sleep(200);
  for (const owner of [a, b]) {
    const rows = JSON.parse(owner.getItem('opencraft.browser-tabs.v1')!);
    assert.deepEqual(rows.map((row: any) => row.id), ['t1']);
    assert.equal(rows[0].viewportMode, 'mobile');
  }
});

test('an in-sync client reconciles from the root fingerprint alone', async t => {
  const { open } = await harness(t);
  const a = await open(), b = await open();
  a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1')]));
  await a.flush();
  await a.reconcile(); await b.reconcile();
  let reads = 0;
  const call = b.call.bind(b);
  b.call = (input?: any, method?: string) => { if (method === 'metadata-digest' && input?.read) reads++; return call(input, method); };
  await b.reconcile();
  assert.equal(reads, 0);
  assert.equal(b.getItem('opencraft.browser-tabs.v1'), a.getItem('opencraft.browser-tabs.v1'));
});

test('successive acknowledged edits use the latest field version without conflicts', async t => {
  const { open } = await harness(t);
  const a = await open();
  let conflicts = 0;
  const call = a.call.bind(a);
  a.call = async (...args: any[]) => {
    try { return await call(...args); } catch (error: any) { if (error.code === 'STATE_CONFLICT') conflicts++; throw error; }
  };
  for (let i = 1; i <= 3; i++) {
    a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1', { createdAt: i })]));
    await a.flush();
  }
  assert.equal(conflicts, 0);
});

test('an ambiguous write retries the same mutation before applying later edits', async t => {
  const { open } = await harness(t);
  const a = await open();
  const call = a.call.bind(a);
  const mutations: string[] = [];
  a.call = async (input?: any, method?: string) => {
    const reply = await call(input, method);
    if (input?.mutationId) {
      mutations.push(input.mutationId);
      if (mutations.length === 1) throw Object.assign(new Error('lost acknowledgement'), { code: 'DISCONNECTED' });
    }
    return reply;
  };
  a.setItem('opencraft.browser-tabs.v1', JSON.stringify([tab('t1')]));
  await a.flush();
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0], mutations[1]);
});
