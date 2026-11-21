import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationResourceLifecycle } from '../../apps/headless-server/src/conversation-resource-lifecycle.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('a synchronous owner failure does not prevent other owners from releasing resources', async () => {
  let released = 0;
  const service = new ConversationResourceLifecycle(null, {
    broken: () => { throw Error('unavailable'); },
    healthy: () => { released++; },
  });
  try {
    await service.observe('h', 't', 'archived');
    await service.observe('h', 't', 'archived');
    assert.equal(released, 1);
    assert.throws(() => service.assertActive('h', 't'));
  } finally { await service.close(); }
});

test('archive fences immediately, retries only failed owners after restart, and preserves other hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-lifecycle-')), path = join(dir, 'state.json');
  const calls = [], hold = deferred();
  let service = new ConversationResourceLifecycle(path, {
    terminal: async row => { calls.push(['terminal', row.hostId]); await hold.promise; },
    browser: async () => { throw Error('owner offline'); },
  });
  try {
    const archive = service.observe('h', 't', 'archived');
    assert.throws(() => service.assertActive('h', 't'));
    service.assertActive('other', 't'); service.assertActive('h', 'other');
    hold.resolve(); await archive; await service.close();
    service = new ConversationResourceLifecycle(path, {
      terminal: async () => assert.fail('completed owner should not be retried'),
      browser: async row => calls.push(['browser', row.hostId]),
    });
    await service.observe('h', 't', 'archived');
    assert.deepEqual(calls, [['terminal', 'h'], ['browser', 'h']]);
    assert.throws(() => service.assertActive('h', 't'));
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('unarchive waits for outstanding cleanup; old acknowledgement cannot open a new archive', async () => {
  const hold = deferred(), entered = deferred(), calls = [];
  const service = new ConversationResourceLifecycle(null, { terminal: async row => {
    calls.push(row.state); if (calls.length === 1) { entered.resolve(); await hold.promise; }
  } });
  try {
    const archive = service.observe('h','t','archived'); await entered.promise;
    const restore = service.observe('h','t','active');
    assert.throws(() => service.assertActive('h','t'));
    hold.resolve(); await Promise.all([archive,restore]);
    service.assertActive('h','t');
    assert.deepEqual(calls, ['archived','active']);
    await service.observe('h','t','deleted'); await service.observe('h','t','active');
    assert.throws(() => service.assertActive('h','t'));
  } finally { await service.close(); }
});

test('idempotent archive does not recreate resource work; restore never restarts commands', async () => {
  const calls=[]; const service = new ConversationResourceLifecycle(null, { owner: async row => calls.push(row.state) });
  try {
    await service.observe('h','t','archived'); await service.observe('h','t','archived');
    assert.deepEqual(calls,['archived']);
    await service.observe('h','t','active'); service.assertActive('h','t');
    assert.deepEqual(calls,['archived','active']);
  } finally { await service.close(); }
});

test('startup reconciliation recovers old archives but a concurrent unarchive wins over stale catalog', async () => {
  const calls=[],service=new ConversationResourceLifecycle(null,{owner:async row=>calls.push(row.threadId)});
  try {
    let page=0;
    assert.equal(await service.reconcileArchived('h',async cursor=>{
      if(page++===0) return {data:[{id:'old'}],nextCursor:'next'};
      assert.equal(cursor,'next'); await service.observe('h','restored','active');
      return {data:[{id:'restored'},{id:'older'}],nextCursor:null};
    }),true);
    assert.throws(()=>service.assertActive('h','old')); assert.throws(()=>service.assertActive('h','older'));
    service.assertActive('h','restored');
    assert.deepEqual(calls,['old','restored','older']);
  } finally {await service.close();}
});

test('a late draft binding invalidates an in-flight cleanup acknowledgement', async () => {
  const entered=deferred(),hold=deferred();let calls=0;
  const service=new ConversationResourceLifecycle(null,{owner:async()=>{if(++calls===1){entered.resolve();await hold.promise;}}});
  try {
    const first=service.observe('h','t','archived');await entered.promise;
    service.resourceLinked('h','t'); hold.resolve();await first;
    assert.equal(calls,2);assert.throws(()=>service.assertActive('h','t'));
  } finally {await service.close();}
});


test('no-progress cleanup retries retain durable fences without rewriting the journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-retry-')), path = join(dir, 'state.json');
  let available = false, calls = 0, writes = 0;
  let service = new ConversationResourceLifecycle(path, { owner: () => { calls++; if (!available) throw Error('offline'); } });
  const write = service.write.bind(service);
  service.write = rows => { writes++; return write(rows); };
  try {
    await service.observe('h', 't', 'archived');
    assert.equal(writes, 1, 'the close intent is durable before invoking its owner');
    const original = await readFile(path, 'utf8');
    await service.observe('h', 't', 'archived');
    service.retry(); await Promise.all([...service.flights.values()]);
    assert.equal(calls, 3, 'owner retries continue even though the journal is unchanged');
    assert.equal(writes, 1);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.throws(() => service.assertActive('h', 't'));
    await service.close();
    service = new ConversationResourceLifecycle(path, { owner: () => { calls++; if (!available) throw Error('offline'); } });
    await service.observe('h', 't', 'active');
    assert.throws(() => service.assertActive('h', 't'), 'restoration still waits for cleanup');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).rows[0].pending, ['owner']);
    available = true;
    await service.observe('h', 't', 'active');
    service.assertActive('h', 't');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).rows[0].pending, []);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('partial cleanup progress writes only the remaining pending owners', async () => {
  let broken = true, healthy = 0, writes = 0;
  const service = new ConversationResourceLifecycle(null, { healthy: () => { healthy++; }, broken: () => { if (broken) throw Error('offline'); } });
  const write = service.write.bind(service); service.write = rows => { writes++; return write(rows); };
  try {
    await service.observe('h', 't', 'archived');
    assert.equal(writes, 2, 'intent and partial acknowledgement both persist');
    await service.observe('h', 't', 'archived');
    assert.equal(writes, 2); assert.equal(healthy, 1);
    broken = false;
    await service.observe('h', 't', 'archived');
    assert.equal(writes, 3); assert.equal(healthy, 1);
    assert.deepEqual([...service.rows.values()][0].pending, []);
  } finally { await service.close(); }
});


test('retry visits only pending cleanup keys and reconstructs them after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-pending-')), path = join(dir, 'state.json');
  let calls = [], online = false;
  const owner = row => { calls.push(row.threadId); if (row.threadId === 'pending' && !online) throw Error('offline'); };
  let service = new ConversationResourceLifecycle(path, { owner });
  try {
    for (const id of ['done-a', 'done-b', 'pending', 'done-c']) await service.observe('h', id, 'archived');
    const pendingKey = JSON.stringify(['h', 'pending']);
    assert.deepEqual([...service.pendingKeys], [pendingKey]);
    const iterate = service.rows[Symbol.iterator];
    service.rows[Symbol.iterator] = () => { throw Error('retry must not scan the historical journal'); };
    calls = []; service.retry(); await Promise.all([...service.flights.values()]);
    assert.deepEqual(calls, ['pending']);
    service.rows[Symbol.iterator] = iterate;
    await service.close();
    service = new ConversationResourceLifecycle(path, { owner });
    assert.deepEqual([...service.pendingKeys], [pendingKey]);
    calls = []; online = true; service.retry(); await Promise.all([...service.flights.values()]);
    assert.deepEqual(calls, ['pending']); assert.equal(service.pendingKeys.size, 0);
    service.rows[Symbol.iterator] = () => { throw Error('empty retry must not scan history'); };
    service.retry(); assert.equal(service.flights.size, 0);
  } finally { await service.close(); await rm(dir, {recursive: true, force: true}); }
});

test('pending index follows new generations, including a late resource link', async () => {
  const entered = deferred(), hold = deferred(); let calls = 0;
  const service = new ConversationResourceLifecycle(null, { owner: async () => { if (++calls === 1) { entered.resolve(); await hold.promise; } } });
  try {
    const pending = service.observe('h', 't', 'archived'); await entered.promise;
    service.resourceLinked('h', 't');
    assert.deepEqual([...service.pendingKeys], [JSON.stringify(['h', 't'])]);
    hold.resolve(); await pending;
    assert.equal(calls, 2); assert.equal(service.pendingKeys.size, 0);
    await service.observe('h', 't', 'active'); service.assertActive('h', 't');
    assert.equal(service.pendingKeys.size, 0);
  } finally { await service.close(); }
});


test('a rejected journal write cannot publish a new pending index', async () => {
  const service = new ConversationResourceLifecycle(null, { owner() { assert.fail('uncommitted cleanup cannot run'); } });
  service.write = () => { throw Error('disk unavailable'); };
  try {
    assert.throws(() => service.observe('h', 't', 'archived'), /disk unavailable/);
    assert.equal(service.pendingKeys.size, 0);
    assert.equal(service.rows.size, 0);
    assert.throws(() => service.assertActive('h', 't'), /unavailable/);
    service.retry(); assert.equal(service.flights.size, 0);
  } finally { await service.close(); }
});


test('archive page admission does not enumerate the historical journal', async () => {
  const service = new ConversationResourceLifecycle(null, { owner() {} });
  try {
    for (const [host, id] of [['h', 'a'], ['h', 'b'], ['other', 'unrelated']]) await service.observe(host, id, 'archived');
    service.rows[Symbol.iterator] = () => { throw Error('page admission must not copy history'); };
    let pages = 0;
    assert.equal(await service.reconcileArchived('h', async cursor => {
      pages++;
      return cursor === null ? {data: [{id: 'a'}], nextCursor: 'older'} : {data: [{id: 'b'}], nextCursor: null};
    }), true);
    assert.equal(pages, 2);
  } finally { await service.close(); }
});

test('page snapshots fence absent and existing rows changed while the page is in flight', async () => {
  const entered = deferred(), response = deferred(), calls = [];
  const service = new ConversationResourceLifecycle(null, { owner: row => { calls.push([row.hostId, row.threadId, row.state]); } });
  try {
    await service.observe('h', 'existing', 'archived');
    const prior = service.rows;
    const run = service.reconcileArchived('h', async () => { entered.resolve(); return response.promise; });
    await entered.promise;
    await service.observe('h', 'existing', 'active');
    await service.observe('h', 'newly-restored', 'active');
    await service.observe('other', 'same-id', 'active');
    assert.equal(prior.get(JSON.stringify(['h', 'existing'])).state, 'archived', 'installed view is not mutated');
    response.resolve({data: [{id: 'existing'}, {id: 'newly-restored'}, {id: 'same-id'}], nextCursor: null});
    assert.equal(await run, true);
    service.assertActive('h', 'existing'); service.assertActive('h', 'newly-restored'); service.assertActive('other', 'same-id');
    assert.throws(() => service.assertActive('h', 'same-id'));
    assert.equal(calls.filter(([host, id, state]) => host === 'h' && id === 'existing' && state === 'archived').length, 1);
  } finally { await service.close(); }
});

test('each archived page takes a fresh admission view and duplicate rows remain idempotent', async () => {
  const calls = [];
  const service = new ConversationResourceLifecycle(null, { owner: row => { calls.push(row.threadId); } });
  try {
    let page = 0;
    assert.equal(await service.reconcileArchived('h', async cursor => {
      if (page++ === 0) return {data: [{id: 'one'}, {id: 'one'}], nextCursor: 'two'};
      assert.equal(cursor, 'two');
      return {data: [{id: 'one'}, {id: 'two'}, {id: 'two'}], nextCursor: null};
    }), true);
    assert.deepEqual(calls, ['one', 'two']);
    assert.equal(service.pendingKeys.size, 0);
  } finally { await service.close(); }
});
