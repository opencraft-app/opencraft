import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openServerCoreOwner } from '@opencraft/storage-node/server-owner';
import { ConversationResourceLifecycle } from '../../apps/headless-server/src/conversation-resource-lifecycle.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
/** A Server core owner Worker in a fresh data directory; `restart` replaces the process-level owner. */
async function serverCore(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  let storage = await openServerCoreOwner(dir);
  return {
    dir, get storage() { return storage; },
    async restart() { await storage.close(); storage = await openServerCoreOwner(dir); return storage; },
    /** Committed rows as another reader of the database sees them. */
    rows() {
      const db = new DatabaseSync(join(dir, 'opencraft-server.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT host_id, thread_id, state, generation, pending FROM conversation_resources ORDER BY host_id, thread_id').all()
        .map(row => ({ hostId: row.host_id, threadId: row.thread_id, state: row.state, generation: row.generation, pending: JSON.parse(row.pending) })); }
      finally { db.close(); }
    },
    async close() { await storage.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

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
  const core = await serverCore('resource-lifecycle-');
  const calls = [], hold = deferred();
  let service = await ConversationResourceLifecycle.open(core.storage, {
    terminal: async row => { calls.push(['terminal', row.hostId]); await hold.promise; },
    browser: async () => { throw Error('owner offline'); },
  });
  try {
    const archive = service.observe('h', 't', 'archived');
    assert.throws(() => service.assertActive('h', 't'));
    service.assertActive('other', 't'); service.assertActive('h', 'other');
    hold.resolve(); await archive; await service.close();
    service = await ConversationResourceLifecycle.open(await core.restart(), {
      terminal: async () => assert.fail('completed owner should not be retried'),
      browser: async row => calls.push(['browser', row.hostId]),
    });
    await service.observe('h', 't', 'archived');
    assert.deepEqual(calls, [['terminal', 'h'], ['browser', 'h']]);
    assert.throws(() => service.assertActive('h', 't'));
  } finally { await service.close(); await core.close(); }
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
  const core = await serverCore('resource-retry-');
  let available = false, calls = 0, writes = 0;
  let service = await ConversationResourceLifecycle.open(core.storage, { owner: () => { calls++; if (!available) throw Error('offline'); } });
  const write = service.write.bind(service);
  service.write = rows => { writes++; return write(rows); };
  try {
    await service.observe('h', 't', 'archived');
    assert.equal(writes, 1, 'the close intent is durable before invoking its owner');
    const original = core.rows();
    await service.observe('h', 't', 'archived');
    service.retry(); await Promise.all([...service.flights.values()]);
    assert.equal(calls, 3, 'owner retries continue even though the journal is unchanged');
    assert.equal(writes, 1);
    assert.deepEqual(core.rows(), original);
    assert.throws(() => service.assertActive('h', 't'));
    await service.close();
    service = await ConversationResourceLifecycle.open(await core.restart(), { owner: () => { calls++; if (!available) throw Error('offline'); } });
    await service.observe('h', 't', 'active');
    assert.throws(() => service.assertActive('h', 't'), 'restoration still waits for cleanup');
    assert.deepEqual(core.rows()[0].pending, ['owner']);
    available = true;
    await service.observe('h', 't', 'active');
    service.assertActive('h', 't');
    assert.deepEqual(core.rows()[0].pending, []);
  } finally { await service.close(); await core.close(); }
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
  const core = await serverCore('resource-pending-');
  let calls = [], online = false;
  const owner = row => { calls.push(row.threadId); if (row.threadId === 'pending' && !online) throw Error('offline'); };
  let service = await ConversationResourceLifecycle.open(core.storage, { owner });
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
    service = await ConversationResourceLifecycle.open(await core.restart(), { owner });
    assert.deepEqual([...service.pendingKeys], [pendingKey]);
    calls = []; online = true; service.retry(); await Promise.all([...service.flights.values()]);
    assert.deepEqual(calls, ['pending']); assert.equal(service.pendingKeys.size, 0);
    service.rows[Symbol.iterator] = () => { throw Error('empty retry must not scan history'); };
    service.retry(); assert.equal(service.flights.size, 0);
  } finally { await service.close(); await core.close(); }
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
    await assert.rejects(service.observe('h', 't', 'archived'), /disk unavailable/);
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

// The journal is written off the event loop. While a write is in flight the
// conversation it closes is fenced, others stay usable, owners wait for the
// durable record, and concurrent intents are serialized without losing either.
test('an in-flight journal write fences only its conversation and serializes concurrent intents', async () => {
  const core = await serverCore('resource-async-');
  const calls = [];
  const service = await ConversationResourceLifecycle.open(core.storage, { owner: row => { calls.push(row.threadId); } });
  const write = service.write.bind(service), held = deferred(); let first = true;
  service.write = async rows => { if (first) { first = false; await held.promise; } return write(rows); };
  try {
    const a = service.observe('h', 'a', 'archived'), b = service.observe('h', 'b', 'archived');
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => service.assertActive('h', 'a')); assert.throws(() => service.assertActive('h', 'b'));
    service.assertActive('h', 'unrelated');
    assert.deepEqual(calls, [], 'owners wait until the close intent is durable');
    held.resolve(); await Promise.all([a, b]);
    assert.deepEqual(calls.sort(), ['a', 'b']);
    const saved = core.rows().map(row => [row.threadId, row.state, row.pending]);
    assert.deepEqual(saved.sort(), [['a', 'archived', []], ['b', 'archived', []]], 'neither intent was lost');
  } finally { await service.close(); await core.close(); }
});

 test('dependent workspace cleanup waits for positive browser cleanup; unrelated owners remain independent',async()=>{
 const entered=deferred(),hold=deferred(),calls=[];let fail=true;const service=new ConversationResourceLifecycle(null,{terminal:async()=>{calls.push('terminal');},browser:async()=>{calls.push('browser');entered.resolve();await hold.promise;if(fail)throw Error('unknown page');},workspace:async()=>{calls.push('workspace');}}, {dependencies:{workspace:['browser']}});
 try{const work=service.observe('h','t','archived');await entered.promise;assert.ok(calls.includes('terminal'));assert.ok(!calls.includes('workspace'));hold.resolve();await work;assert.ok(!calls.includes('workspace'));assert.deepEqual(service.rows.get(JSON.stringify(['h','t'])).pending,['browser','workspace']);fail=false;await service.observe('h','t','archived');assert.equal(calls.at(-1),'workspace');}finally{await service.close();}
 });
 test('startup replays newly installed cleanup owners on completed closed rows, never active rows, without resetting the canonical generation',async()=>{
 const core=await serverCore('resource-owner-replay-');let service=await ConversationResourceLifecycle.open(core.storage,{browser:async()=>{}});
 try{await service.observe('h','closed','archived');await service.observe('h','open','active');await service.close();const calls=[];service=await ConversationResourceLifecycle.open(core.storage,{browser:async r=>calls.push(['browser',r.threadId]),workspace:async r=>calls.push(['workspace',r.threadId])},{replayOwners:['browser','workspace'],dependencies:{workspace:['browser']}});assert.equal(service.rows.get(JSON.stringify(['h','closed'])).generation,1);await service.observe('h','closed','archived');assert.deepEqual(calls,[['browser','closed'],['workspace','closed']]);service.assertActive('h','open');assert.deepEqual(core.rows().map(r=>[r.threadId,r.generation,r.pending]),[['closed',1,[]],['open',1,[]]]);}finally{await service.close();await core.close();}
 });
 test('cyclic or unknown resource-owner dependencies fail closed',()=>{
 assert.throws(()=>new ConversationResourceLifecycle(null,{a:async()=>{},b:async()=>{}},{dependencies:{a:['b'],b:['a']}}),/Cyclic/);assert.throws(()=>new ConversationResourceLifecycle(null,{a:async()=>{}},{dependencies:{a:['missing']}}),/Invalid/);
 });

// The retired journal (conversation-resources.json) is imported once by the
// Server core owner when the lifecycle opens, and kept unchanged as a backup.
const legacyJournal = rows => JSON.stringify({ version: 1, rows });
test('the retired JSON journal imports once with its generations and pending owners, and stays unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-import-'));
  const legacy = legacyJournal([
    { hostId: 'h', threadId: 'archived', state: 'archived', generation: 3, pending: ['browser'] },
    { hostId: 'h', threadId: 'active', state: 'active', generation: 2, pending: [] },
    { hostId: 'other', threadId: 'archived', state: 'deleted', generation: 1, pending: [] },
  ]);
  await writeFile(join(dir, 'conversation-resources.json'), legacy, { mode: 0o600 });
  let storage = await openServerCoreOwner(dir), service;
  const calls = [];
  const owners = { terminal: () => {}, browser: row => { calls.push(row.threadId); throw Error('offline'); } };
  try {
    service = await ConversationResourceLifecycle.open(storage, owners);
    assert.deepEqual([...service.pendingKeys], [JSON.stringify(['h', 'archived'])]);
    assert.equal(service.rows.get(JSON.stringify(['h', 'archived'])).generation, 3);
    assert.throws(() => service.assertActive('h', 'archived'));
    service.assertActive('h', 'active');
    assert.throws(() => service.assertActive('other', 'archived'));
    await service.observe('h', 'active', 'archived');
    await service.close();
    // A restart (same file, same receipt) never replays the journal over newer rows.
    await storage.close(); storage = await openServerCoreOwner(dir);
    service = await ConversationResourceLifecycle.open(storage, owners);
    assert.equal(service.rows.get(JSON.stringify(['h', 'active'])).generation, 3);
    assert.equal(service.rows.get(JSON.stringify(['h', 'active'])).state, 'archived');
    assert.equal(await readFile(join(dir, 'conversation-resources.json'), 'utf8'), legacy, 'the backup is never written');
    // Removing the kept backup is an operator action, not evidence of an older writer.
    await service.close(); await rm(join(dir, 'conversation-resources.json'));
    service = await ConversationResourceLifecycle.open(storage, owners);
    assert.equal(service.rows.get(JSON.stringify(['h', 'active'])).state, 'archived');
    const db = new DatabaseSync(join(dir, 'opencraft-server.sqlite'), { readOnly: true });
    try {
      const receipt = db.prepare('SELECT source, sha256, rows FROM conversation_resource_imports').all();
      assert.deepEqual(receipt.map(r => [r.source, r.rows]), [['conversation-resources.json', 3]]);
      assert.equal(receipt[0].sha256, createHash('sha256').update(legacy).digest('hex'));
    } finally { db.close(); }
  } finally { await service?.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a journal changed after import, or created after an absent import, refuses to open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-import-changed-'));
  let storage = await openServerCoreOwner(dir);
  try {
    // No journal: the absence is the imported source.
    await (await ConversationResourceLifecycle.open(storage, { owner() {} })).close();
    // An older writer (e.g. after a rollback) recreates it; merging could regress generations.
    await writeFile(join(dir, 'conversation-resources.json'), legacyJournal([{ hostId: 'h', threadId: 't', state: 'active', generation: 1, pending: [] }]));
    await assert.rejects(ConversationResourceLifecycle.open(storage, { owner() {} }), /changed after its import/);
    await rm(join(dir, 'conversation-resources.json'));
    await (await ConversationResourceLifecycle.open(storage, { owner() {} })).close();
  } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a corrupt, truncated or unknown-owner journal refuses to open and imports nothing', async () => {
  for (const [name, text] of [
    ['truncated', '{"version":1,"rows":[{"hostId":"h"'],
    ['wrong version', JSON.stringify({ version: 2, rows: [] })],
    ['bad record', legacyJournal([{ hostId: 'h', threadId: 't', state: 'closed', generation: 1, pending: [] }])],
    ['unknown owner', legacyJournal([{ hostId: 'h', threadId: 't', state: 'archived', generation: 1, pending: ['retired-owner'] }])],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'resource-import-corrupt-'));
    await writeFile(join(dir, 'conversation-resources.json'), text);
    const storage = await openServerCoreOwner(dir);
    try {
      await assert.rejects(ConversationResourceLifecycle.open(storage, { owner() {} }), /Invalid conversation resource/, name);
      assert.equal(await readFile(join(dir, 'conversation-resources.json'), 'utf8'), text, name);
      const db = new DatabaseSync(join(dir, 'opencraft-server.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM conversation_resources').get().n, 0, name);
        assert.equal(db.prepare('SELECT count(*) n FROM conversation_resource_imports').get().n, 0, name);
      } finally { db.close(); }
    } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('a closed or lost Server core owner fences bound conversations and refuses later intents', async () => {
  const core = await serverCore('resource-owner-lost-');
  const service = await ConversationResourceLifecycle.open(core.storage, { owner() {} });
  try {
    service.assertActive('h', 't');
    await core.storage.close();
    await assert.rejects(service.observe('h', 't', 'archived'));
    assert.throws(() => service.assertActive('h', 'other'), /unavailable/);
    service.assertActive('h', undefined);
  } finally { await service.close(); await rm(core.dir, { recursive: true, force: true }); }
});
