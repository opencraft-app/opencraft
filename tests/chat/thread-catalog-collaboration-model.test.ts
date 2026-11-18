import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { bindHostQueryRecovery } from '../../apps/workbench-web/src/runtime/host-query-recovery';
import { QueryClient } from '@tanstack/react-query';
import { ThreadCatalogPublisher } from '@opencraft/app-host-server/thread-catalog';
import { threadCatalogUpdates } from '../../apps/workbench-web/src/runtime/thread-catalog-updates';
import { bindThreadCatalogNotifications } from '../../apps/workbench-web/src/runtime/thread-catalog-notifications';
import { mergeThreadCatalogPages, sidebarThreadCatalogQueryKey } from '../../apps/workbench-web/src/runtime/thread-catalog-query';
import { writeCachedThreadName } from '../../apps/workbench-web/src/runtime/thread-title-cache';

/** Two independent cache owners, real publisher + real notification/projector.
 * Fanout, authorization and network are explicit synthetic ports, NOT a tested
 * production WebSocket/ACL implementation or two physical devices. */
function fixture(overlapOnB = false) {
  const hostId = 'shared-server-route', threadId = 'shared-thread';
  let server = { id: threadId, name: 'original', preview: '', cwd: '/synthetic', createdAt: 1,
    updatedAt: 100, recencyAt: 100, pinned: true, status: { type: 'idle' }, ephemeral: false, turns: [] };
  let commits = 0, broadcasts = 0, freshReads = 0;
  const devices = ['A', 'B'].map(id => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const key = sidebarThreadCatalogQueryKey(hostId, { revision: 1, authorizationEpoch: 1, clientEpoch: 0 });
    const journal = threadCatalogUpdates(query, key, hostId); journal.enabled = true;
    const device = { id, query, key, journal, connected: true, allowed: true, generation: 0,
      queue: [] as Array<{ generation: number; event: any }>, receive: (_event: any) => {}, stop: () => {} };
    const generation = device.generation;
    device.stop = bindThreadCatalogNotifications({ subscribeNotification(receive) {
      device.receive = receive; return () => {};
    } }, hostId, query, () => device.allowed && device.generation === generation);
    const first = { data: [structuredClone(server)], nextCursor: overlapOnB && id === 'B' ? 'tail' : null };
    query.setQueryData(key, { pages: [first, ...(overlapOnB && id === 'B' ? [{ data: [{ ...server, name: 'old', pinned: false, updatedAt: 20 }], nextCursor: null }] : [])],
      pageParams: overlapOnB && id === 'B' ? [null, 'tail'] : [null] });
    return device;
  });
  const publisher = new ThreadCatalogPublisher((method, params) => {
    broadcasts++;
    for (const device of devices) if (device.allowed && device.connected) {
      device.queue.push({ generation: device.generation, event: { method, params: structuredClone(params) } });
    }
  });
  const [a, b] = devices as [typeof devices[number], typeof devices[number]];
  const view = (device: typeof a) => {
    const raw: any = device.query.getQueryData(device.key);
    return device.journal.project(raw ? { ...raw.pages[0], data: mergeThreadCatalogPages(raw.pages) } : undefined)?.data as Array<typeof server> | undefined;
  };
  const deliver = (device: typeof a) => {
    if (!device.connected) return;
    for (const packet of device.queue.splice(0)) if (packet.generation === device.generation) device.receive(packet.event);
  };
  const rename = (device: typeof a, name: string) => {
    assert.ok(device.allowed && device.connected);
    server = { ...server, name }; commits++;
    // The source receipt updates this device's cache; it is NOT cross-device sync.
    writeCachedThreadName(device.query, { hostId, threadId }, name);
    publisher.observeResult('thread/name/set', { threadId, name }, {});
  };
  const freshRead = (device: typeof a) => {
    assert.ok(device.allowed && device.connected); freshReads++;
    const page = device.journal.markRead({ data: [structuredClone(server)], nextCursor: null } as any, device.journal.getSnapshot());
    device.query.setQueryData(device.key, { pages: [page], pageParams: [null] });
    device.journal.acknowledge(page);
  };
  return { a, b, publisher, view, deliver, rename, freshRead,
    counters: () => ({ commits, broadcasts, freshReads }),
    close() { for (const device of devices) { device.stop(); device.query.clear(); } } };
}

test('committed rename reaches an independently mounted peer catalog without opening the Thread', t => {
  const f = fixture(); t.after(() => f.close());
  assert.notEqual(f.a.query, f.b.query); assert.deepEqual(f.a.key, f.b.key);
  f.rename(f.a, 'shared-name');
  assert.equal(f.view(f.a)![0]!.name, 'shared-name');
  assert.equal(f.view(f.b)![0]!.name, 'original', 'local acknowledgement alone cannot update another device');
  assert.equal(f.b.queue.length, 1, 'the committed owner publishes to the peer, not only the request source');
  f.deliver(f.b); f.deliver(f.a);
  assert.equal(f.view(f.b)![0]!.name, 'shared-name');
  assert.equal(f.view(f.b)![0]!.pinned, true);
  assert.deepEqual(f.counters(), { commits: 1, broadcasts: 1, freshReads: 0 });
});
test('duplicate broadcasts are idempotent in each independent device journal', t => {
  const f = fixture(); t.after(() => f.close()); f.rename(f.a, 'shared-name');
  const event = structuredClone(f.b.queue[0]!.event); f.deliver(f.b);
  const revision = f.b.journal.getSnapshot(); f.b.receive(event); f.b.receive(event);
  assert.equal(f.b.journal.getSnapshot(), revision); assert.equal(f.view(f.b)![0]!.name, 'shared-name');
});
test('offline peer recovers from an admitted fresh snapshot, without replaying the mutation', t => {
  const f = fixture(); t.after(() => f.close()); f.b.connected = false;
  f.rename(f.a, 'after-disconnect'); f.deliver(f.a);
  assert.equal(f.b.queue.length, 0); assert.equal(f.view(f.b)![0]!.name, 'original');
  f.b.connected = true; f.freshRead(f.b);
  assert.equal(f.view(f.b)![0]!.name, 'after-disconnect');
  assert.deepEqual(f.counters(), { commits: 1, broadcasts: 1, freshReads: 1 });
});
test('revoked peer drops retained catalog data and ignores a late broadcast, without affecting the source', t => {
  const f = fixture(); t.after(() => f.close()); f.rename(f.a, 'committed');
  const late = structuredClone(f.b.queue[0]!.event);
  f.b.receive({ method: 'opencraft/thread-access/revoked', params: { threadId: 'shared-thread', local: true } });
  f.b.allowed = false; f.b.generation++; f.b.journal.enabled = false;
  f.b.receive(late); assert.equal(f.view(f.b)?.length ?? 0, 0);
  f.deliver(f.a); assert.equal(f.view(f.a)![0]!.name, 'committed');
});
test('broadcast plus materialization converges across independent devices with different page layouts', t => {
  const f = fixture(true); t.after(() => f.close()); f.rename(f.a, 'shared-name');
  f.deliver(f.a); f.deliver(f.b);
  for (const device of [f.a, f.b]) device.query.setQueryData(device.key, (data: any) => device.journal.materialize(data));
  assert.equal(f.view(f.a)![0]!.name, f.view(f.b)![0]!.name);
  assert.equal(f.view(f.a)![0]!.pinned, true);
  assert.equal(f.view(f.b)![0]!.pinned, true, 'the peer preserves the native pin just like the source');
});

test('two source devices converge to the native commit order, without fabricating activity time', t => {
  const f = fixture(); t.after(() => f.close());
  f.rename(f.a, 'first-commit'); f.deliver(f.a); f.deliver(f.b);
  f.rename(f.b, 'second-commit'); f.deliver(f.a); f.deliver(f.b);
  for (const device of [f.a, f.b]) {
    assert.equal(f.view(device)![0]!.name, 'second-commit');
    assert.equal(f.view(device)![0]!.updatedAt, 100);
    assert.equal(f.view(device)![0]!.recencyAt, 100);
  }
  assert.deepEqual(f.counters(), { commits: 2, broadcasts: 2, freshReads: 0 });
});


test('a healed peer with an unconfirmed old fact observes the mutation missed while disconnected', async t => {
  const f = fixture(true); t.after(() => f.close());
  const listeners = new Set<() => void>();
  let snapshot = { phase: 'ready', connectionGeneration: 1 };
  const stop = bindHostQueryRecovery({ getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } }, 'shared-server-route', f.b.query);
  t.after(stop); await tick();
  f.rename(f.a, 'before-loss'); f.deliver(f.a); f.deliver(f.b);
  assert.equal(f.b.journal.hasPending, true);
  snapshot = { phase: 'reconnecting', connectionGeneration: 1 }; listeners.forEach(fn => fn());
  f.b.journal.enabled = false; // React may not have repainted the ready phase yet.
  f.b.connected = false; f.rename(f.a, 'missed-during-loss'); f.deliver(f.a);
  f.b.connected = true; snapshot = { phase: 'ready', connectionGeneration: 2 }; listeners.forEach(fn => fn());
  await tick(); f.b.journal.enabled = true; f.freshRead(f.b);
  assert.equal(f.view(f.b)![0]!.name, 'missed-during-loss');
  assert.equal(f.view(f.b)![0]!.pinned, true);
  assert.equal(f.counters().commits, 2, 'catch-up never resubmits a mutation');
});
