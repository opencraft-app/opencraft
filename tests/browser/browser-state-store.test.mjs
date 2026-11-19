import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { BrowserStateStore } from '../../scripts/remote-browser/state-store.mjs';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
import { recordRetirementFacts } from '../../scripts/remote-browser/retirement-facts.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-sqlite-')), stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, async open() { const store = new BrowserStateStore(directory); stores.push(store); await store.open(); return store; } };
}
const empty = () => ({ schemaVersion: 1, pages: [], states: [], retired: [] });
const keyFor = index => JSON.stringify(['owner', 'browser-' + index.toString(16).padStart(64, '0')]);
const nativePage = key => ({ key, id: createHash('sha256').update(key).digest('hex'), ownerId: 'owner', lifecycle: 'open', runtime: { kind: 'absent' } });

test('one SQLite commit publishes page, account metadata, close receipt and permanent facts together', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(1), lease = JSON.parse(key)[1];
  await store.transact(draft => {
    draft.pages.push(nativePage(key)); draft.states.push(['owner', { revision: 1, values: { pages: '[]' } }]);
    draft.closedTabs.push({ key, ownerId: 'owner', lease, tabId: 'tab', pageId: 'page', scopeId: 'scope', status: 'closing', pageIds: ['page'], tabIds: ['tab'] });
    draft.retired.push(key); recordRetirementFacts(draft, { key, ownerId: 'owner', lease, pageIds: ['page'], tabIds: ['tab'] });
  }, { keys: [key] });
  await store.close();
  const restored = await f.open();
  assert.equal(restored.current.pages.length, 1); assert.equal(restored.current.states[0][1].revision, 1);
  assert.equal(restored.current.closedTabs[0].status, 'closing'); assert(await restored.hasRetirement(key));
  assert(restored.current.retiredResources.get(key).pageIds.includes('page'));
  assert.equal((await stat(join(f.directory, 'state.sqlite'))).mode & 0o777, 0o600);
});

test('a SQLite failure in the last table rolls back resource, metadata and receipt changes', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(2);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER refuse_retirement BEFORE INSERT ON browser_retirements BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(store.transact(draft => {
    draft.pages.push(nativePage(key)); draft.states.push(['owner', { revision: 1, values: {} }]); draft.closedTabs.push({ key }); draft.retired.push(key);
  }), /fixture failure/);
  assert.equal(store.current.pages.length, 0);
  for (const table of ['browser_pages', 'browser_metadata', 'browser_receipts', 'browser_retirements']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  db.exec('DROP TRIGGER refuse_retirement');
  await store.close(); const restored = await f.open(); assert.equal(restored.current.pages.length, 0);
});

test('legacy JSON imports once and cannot overwrite a later SQLite retirement', async t => {
  const f = await fixture(t), key = keyFor(3), saved = empty(); saved.pages.push(nativePage(key));
  const source = JSON.stringify(saved); await writeFile(join(f.directory, 'tabs.json'), source);
  const store = await f.open();
  await store.transact(draft => { draft.pages = []; draft.retired.push(key); }); await store.close();
  assert.equal(await readFile(join(f.directory, 'tabs.imported.json'), 'utf8'), source);
  const reopened = await f.open(); assert.equal(reopened.current.pages.length, 0); assert(await reopened.hasRetirement(key)); await reopened.close();
  await writeFile(join(f.directory, 'tabs.json'), source + '\n');
  await assert.rejects(f.open(), /changed after migration/);
});

test('invalid legacy import is atomic and a corrected source can retry before any installation is admitted', async t => {
  const f = await fixture(t), saved = empty(), page = nativePage(keyFor(4)); saved.pages.push(page, page);
  await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(saved));
  await assert.rejects(f.open(), /UNIQUE/);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM browser_pages').get().n, 0); db.close();
  await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(empty()));
  const restored = await f.open(); assert.equal(restored.current.pages.length, 0);
});

test('a migrated installation refuses a lost database instead of reimporting frozen JSON', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(empty()));
  const store = await f.open(); await store.transact(draft => draft.retired.push(keyFor(5))); await store.close();
  await rm(join(f.directory, 'state.sqlite'));
  await assert.rejects(f.open(), /database missing after migration/);
});

test('ordinary transactions never clone or serialize the permanent history and send only changed rows', async t => {
  const f = await fixture(t), saved = empty(); saved.retired = Array.from({ length: 20000 }, (_, index) => keyFor(index));
  await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(saved));
  const store = await f.open(), history = store.current.retiredResources;
  const calls = [], call = store.call.bind(store); store.call = (op, args) => { if (op === 'commit') calls.push(args); return call(op, args); };
  // Any attempted enumeration/serialization of permanent history in the commit
  // hot path fails, rather than relying on timing thresholds in a scale test.
  history[Symbol.iterator] = history.toJSON = () => { throw Error('History scanned during ordinary write'); };
  await store.transact(draft => draft.states.push(['owner', { revision: 1, values: {} }]));
  assert.equal(store.current.retiredResources, history); assert.equal(calls.length, 1);
  assert(calls[0].facts.length === 0 && JSON.stringify(calls[0]).length < 300);
  await store.transact(draft => draft.retired.push(keyFor(20001)));
  assert.equal(calls[1].facts.length, 1); assert(JSON.stringify(calls[1]).length < 1000);
  await assert.rejects(store.transact(draft => { draft.retiredResources = []; }), /cannot be replaced/);
  await assert.rejects(store.transact(draft => { const fact = draft.retiredResources.get(keyFor(1)); fact.pageIds = []; }, { keys: [keyFor(1)] }), /cannot be removed/);
});

test('shutdown drains accepted transactions, rejects later reducers and Worker loss has no fallback', async t => {
  const f = await fixture(t), store = await f.open();
  const accepted = store.transact(draft => draft.retired.push(keyFor(7))), closing = store.close();
  await assert.rejects(store.transact(() => assert.fail('closed reducer ran')), /closing/);
  await accepted; await closing;
  const restored = await f.open(); assert(await restored.hasRetirement(keyFor(7)));
  await restored.worker.terminate();
  await assert.rejects(restored.transact(draft => draft.pages.push(nativePage(keyFor(8)))), /worker exited/);
  await restored.close(); const next = await f.open(); assert.equal(next.current.pages.length, 0);
});

test('a SQLite writer wait leaves the event loop responsive and a queued commit resumes once', async t => {
  const f = await fixture(t), store = await f.open(), db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  t.after(() => db.close()); db.exec('BEGIN IMMEDIATE');
  let ticks = 0; const timer = setInterval(() => ticks++, 5); let settled = false;
  const writing = store.transact(draft => draft.retired.push(keyFor(9))).then(() => settled = true);
  await new Promise(resolve => setTimeout(resolve, 100)); clearInterval(timer);
  assert(ticks >= 5); assert.equal(settled, false); db.exec('ROLLBACK'); await writing;
  assert(store.current.retired.includes(keyFor(9)));
});

test('bundled service ships a standalone Worker and recovers its durable state without source loaders', async t => {
  const f = await fixture(t), bundle = join(f.directory, 'bundle'); await mkdir(bundle);
  await Promise.all([
    build({ entryPoints: ['scripts/remote-browser-service.mjs'], outfile: join(bundle, 'service.mjs'), bundle: true, platform: 'node', format: 'esm',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: 'silent' }),
    build({ entryPoints: ['scripts/remote-browser/state.worker.ts'], outfile: join(bundle, 'browser-state-worker.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' }),
  ]);
  const worker = await readFile(join(bundle, 'browser-state-worker.mjs'), 'utf8'); assert(!worker.includes("from 'tsx"));
  await writeFile(join(bundle, 'probe.mjs'), `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    require('node:sqlite').DatabaseSync = class { constructor() { throw Error('Main-thread SQL is forbidden'); } };
    syncBuiltinESMExports();
    const { RemoteBrowserService } = await import('./service.mjs');
    const directory = process.argv[2], key = JSON.stringify(['owner','browser-retired']);
    const create = () => new RemoteBrowserService({root:directory,dataDirectory:directory,ownerConnector:null});
    const first=create(); await first.load(); await first.commit(draft=>draft.retired.push(key)); first.close(); await first.persistence;
    const second=create(); await second.load(); if(!await second.store.hasRetirement(key)) throw Error('Retirement lost');
    second.close(); await second.persistence; console.log('standalone-worker-recovery-ok');
  `);
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const result = await promisify(execFile)(process.execPath, [join(bundle, 'probe.mjs'), f.directory], { timeout: 15000 });
  assert.match(result.stdout, /standalone-worker-recovery-ok/);
});

test('a lost commit acknowledgement stays unknown in memory and recovers the committed transaction on reopen', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(10);
  // The real Worker commits, then its transport acknowledgement is lost.
  store.worker.removeAllListeners('message');
  const { once } = await import('node:events');
  const response = once(store.worker, 'message');
  const writing = store.transact(draft => { draft.retired.push(key); draft.states.push(['owner', { revision: 1, values: {} }]); });
  const rejected = assert.rejects(writing, { outcome: 'unknown' });
  assert.equal((await response)[0].error, undefined); await store.worker.terminate(); await rejected;
  assert.equal(store.current.retiredResources.length, 0);
  await store.close(); const restored = await f.open();
  assert(await restored.hasRetirement(key)); assert.equal(restored.current.states[0][1].revision, 1);
});

test('Worker failure closes the owning service and releases the writer for recovery', async t => {
  const f = await fixture(t), options = { root: f.directory, dataDirectory: f.directory, ownerConnector: null };
  const service = new RemoteBrowserService(options); t.after(async () => { service.close(); await service.persistence; });
  await service.load(); assert.equal(service.storageOutcomes()[0].name, 'remote-browser');
  await service.store.worker.terminate(); assert.equal(service.closed, true); await service.persistence;
  await assert.rejects(service.load(), /closed/); assert.deepEqual(service.storageOutcomes(), []);
  const replacement = new RemoteBrowserService(options); t.after(async () => { replacement.close(); await replacement.persistence; });
  await replacement.load(); assert.equal(replacement.store.current.pages.length, 0);
});

test('fact updates preserve earlier identities and the Worker refuses a delta that would erase them', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(11), lease = JSON.parse(key)[1];
  await store.transact(draft => draft.retired.push(key));
  const original = store.current.retiredResources.get(key).pageIds[0];
  await store.transact(draft => recordRetirementFacts(draft, { key, ownerId: 'owner', lease, pageIds: ['legacy-page'], tabIds: ['legacy-tab'] }), { keys: [key] });
  assert(store.current.retiredResources.get(key).pageIds.includes(original));
  assert(store.current.retiredResources.get(key).pageIds.includes('legacy-page'));
  await assert.rejects(store.call('commit', { changes: {
    pages: { remove: [], put: [] }, closedTabs: { remove: [], put: [] }, states: { remove: [], put: [['owner', JSON.stringify({ revision: 1, values: {} })]] },
  }, facts: [{ key, ownerId: 'owner', lease, pageIds: [], tabIds: [] }] }), /cannot be removed/);
  await store.close(); const restored = await f.open();
  assert.equal(restored.current.states.length, 0);
  await restored.transact(() => {}, { keys: [key] }); assert(restored.current.retiredResources.get(key).pageIds.includes(original));
  assert(restored.current.retiredResources.get(key).pageIds.includes('legacy-page'));
});

test('cold SQL startup and indexed retirement reads stay bounded by referenced identities', async t => {
  const f = await fixture(t), saved = empty(); saved.retired = Array.from({ length: 20000 }, (_, index) => keyFor(index));
  await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(saved));
  const original = await f.open(); await original.close();
  const cold = new BrowserStateStore(f.directory), messages = [], call = cold.call.bind(cold);
  t.after(() => cold.close()); cold.call = async (op, args) => { const result = await call(op, args); messages.push([op, JSON.stringify(result).length]); return result; };
  await cold.open(); assert.equal(cold.current.retiredResources.length, 0);
  assert(messages.every(([, bytes]) => bytes < 2000), 'startup must not fetch complete retirement history');
  const id = '0000000000000000000000000000000000000000000000000000000000000001';
  const selected = await cold.readRetirements('owner', { pages: ['page-' + id, 'unseen'], tabs: ['tab-' + id], leases: ['browser-' + id] });
  assert.deepEqual(selected.references.pages, ['page-' + id]); assert.equal(selected.references.tabs.length, 1); assert.equal(selected.references.leases.length, 1);
  assert(JSON.stringify(selected).length < 1000);
  const other = await cold.readRetirements('other', { pages: ['page-' + id], tabs: [], leases: [] }); assert.deepEqual(other.references.pages, []);
  assert(await cold.hasRetirement(keyFor(1))); assert.equal(await cold.hasRetirement(keyFor(30000)), false);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try { assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM browser_retirement_identities WHERE owner=? AND kind=? AND id=? LIMIT 1').all('owner', 'page', 'page-' + id)), /SEARCH.*COVERING INDEX/); }
  finally { db.close(); }
});

test('v1 SQL upgrades its historical identity index without changing the published migration prefix', async t => {
  const f = await fixture(t);
  const { openManagedDatabase } = await import('@opencraft/sqlite-node');
  const { migrations } = await import('../../scripts/remote-browser/state-migrations.ts');
  const { database } = openManagedDatabase({ path: join(f.directory, 'state.sqlite'), migrations, legacyPolicy: 'reject' });
  const key = keyFor(17), fact = { key, ownerId: 'owner', lease: JSON.parse(key)[1], pageIds: ['historical-page'], tabIds: ['historical-tab'] };
  database.prepare('INSERT INTO browser_retirements VALUES (?,?,?)').run(key, 'owner', JSON.stringify(fact));
  const set = database.prepare('INSERT INTO browser_meta VALUES (?,?)'); set.run('import-complete', '1'); set.run('legacy-digest', 'absent'); set.run('installation', 'upgrade-fixture');
  const before = database.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum; database.close();
  const upgraded = await f.open(); assert.equal(upgraded.outcome.appliedVersion, 4); assert(await upgraded.hasRetirement(key));
  const matched = await upgraded.readRetirements('owner', { pages: ['historical-page'], tabs: ['historical-tab'], leases: [fact.lease] });
  assert.deepEqual(matched.references.pages, fact.pageIds); assert.deepEqual(matched.references.tabs, fact.tabIds);
  await upgraded.close(); const after = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try { assert.equal(after.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum, before); }
  finally { after.close(); }
});


test('account metadata transactions never clone or serialize foreign account payloads', async t => {
  const f = await fixture(t), store = await f.open();
  await store.transact(draft => {
    draft.states.push(['local', { revision: 1, values: {} }], ['foreign', { revision: 3, values: {} }]);
  });
  const foreign = store.account('foreign').states[0][1];
  foreign.toJSON = () => { throw Error('Foreign account serialized'); };
  // A function also makes structuredClone fail if foreign state enters the draft.
  await store.transact(draft => {
    assert.equal(draft.states.length, 1);
    draft.states[0][1].revision++;
  }, { ownerId: 'local' });
  assert.equal(store.account('local').states[0][1].revision, 2);
  assert.equal(store.account('foreign').states[0][1], foreign);
  await assert.rejects(store.transact(draft => {
    draft.states[0][1].revision = 99;
    draft.states.push(['foreign', { revision: 4, values: {} }]);
  }, { ownerId: 'local' }), /crossed owner scope/);
  assert.equal(store.account('local').states[0][1].revision, 2);
  delete foreign.toJSON;
});


test('scoped publication preserves snapshots without materializing global arrays and counts foreign capacity', async t => {
  const f = await fixture(t), store = await f.open();
  await store.transact(draft => {
    for (let index = 0; index < 64; index++) {
      const key = JSON.stringify(['foreign-' + index, 'browser-capacity']);
      draft.pages.push({ ...nativePage(key), ownerId: 'foreign-' + index, runtime: { kind: 'unknown' } });
    }
    draft.states.push(['local', { revision: 1, values: {} }]);
  });
  const before = store.current;
  for (const field of ['pages', 'states', 'closedTabs']) Object.defineProperty(before, field, {
    get() { throw Error('Global directory materialized'); }, configurable: true,
  });
  await store.transact(draft => {
    assert.equal(draft.capacityUsed, 64);
    assert.equal(draft.pages.length, 0);
    draft.states[0][1].revision++;
  }, { ownerId: 'local' });
  const snapshot = store.current;
  await store.transact(draft => { draft.states[0][1].revision++; }, { ownerId: 'local' });
  assert.equal(snapshot.states.find(([owner]) => owner === 'local')[1].revision, 2);
  assert.equal(store.current.states.find(([owner]) => owner === 'local')[1].revision, 3);
  assert.equal(store.current.pages.length, 64);
  assert.equal(store.accounts.used, 64);
  await store.transact(draft => { draft.pages[0].runtime.kind = 'absent'; }, { ownerId: 'foreign-0' });
  assert.equal(store.accounts.used, 63);
  assert.equal(snapshot.pages.length, 64);
  assert.equal(snapshot.pages.find(row => row.ownerId === 'foreign-0').runtime.kind, 'unknown');
});

test('resource-only reconciliation skips metadata, receipts and retirement queries and preserves snapshots', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(88001);
  await store.transact(draft => {
    draft.pages.push({ ...nativePage(key), runtime: { kind: 'unknown' } });
    for (let index = 0; index < 1000; index++) draft.states.push(['metadata-' + index, { revision: 1, values: { bindings: '[]' } }]);
    draft.states.push(['owner', { revision: 7, values: {} }]);
  });
  const account = store.account('owner'), metadata = store.account('metadata-500'), snapshot = store.current;
  for (const field of ['states', 'closedTabs']) Object.defineProperty(snapshot, field, {
    get() { throw Error('Unrelated global rows enumerated'); }, configurable: true,
  });
  metadata.states[0][1].toJSON = () => { throw Error('Unrelated metadata serialized'); };
  const calls = [], call = store.call.bind(store);
  store.call = (op, args) => { assert.notEqual(op, 'select'); calls.push({ op, args }); return call(op, args); };
  await store.transact(draft => {
    assert.deepEqual(Object.keys(draft), ['pages']);
    assert.equal(draft.capacityUsed, 1);
    draft.pages[0].runtime.kind = 'absent';
  }, { resourcesOnly: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].op, 'commit');
  assert.deepEqual(calls[0].args.changes.states, { put: [], remove: [] });
  assert.deepEqual(calls[0].args.changes.closedTabs, { put: [], remove: [] });
  assert.deepEqual(calls[0].args.facts, []);
  assert.equal(store.account('owner').states, account.states);
  assert.equal(store.account('metadata-500'), metadata);
  assert.equal(snapshot.pages[0].runtime.kind, 'unknown');
  assert.equal(store.accounts.used, 0);
  await store.transact(() => {}, { resourcesOnly: true });
  assert.equal(calls.length, 1, 'no-change reconciliation must not write');
  delete metadata.states[0][1].toJSON;
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT value FROM browser_pages WHERE key = ?').get(key).value).runtime.kind, 'absent');
    assert.equal(db.prepare('SELECT count(*) AS n FROM browser_metadata').get().n, 1001);
  } finally { db.close(); }
});

test('resource-only transactions reject lifecycle, identity and non-resource changes without publication', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(88002);
  await store.transact(draft => { draft.pages.push(nativePage(key)); });
  const snapshot = store.current, calls = [], call = store.call.bind(store);
  store.call = (op, args) => { calls.push(op); return call(op, args); };
  for (const reduce of [
    draft => { draft.pages = []; },
    draft => { draft.pages[0].key = keyFor(88003); },
    draft => { draft.pages[0].ownerId = 'foreign'; },
    draft => { draft.pages[0].lifecycle = 'closing'; },
    draft => { draft.pages[0].link = { tabId: 'forged' }; },
    draft => { draft.states = []; },
    draft => { draft.pages[0].runtime.kind = 'unknown'; throw Error('rejected draft'); },
  ]) await assert.rejects(store.transact(reduce, { resourcesOnly: true }));
  assert.equal(store.current, snapshot);
  assert.equal(store.accounts.used, 0);
  assert.deepEqual(calls, []);
});

test('failed resource commit retains the prior directory and capacity aggregate', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(88004);
  await store.transact(draft => { draft.pages.push({ ...nativePage(key), runtime: { kind: 'unknown' } }); });
  const snapshot = store.current, call = store.call.bind(store);
  store.call = (op, args) => { if (op === 'commit') throw Error('injected resource commit failure'); return call(op, args); };
  await assert.rejects(store.transact(draft => { draft.pages[0].runtime.kind = 'absent'; }, { resourcesOnly: true }), /injected resource commit failure/);
  assert.equal(store.current, snapshot);
  assert.equal(store.current.pages[0].runtime.kind, 'unknown');
  assert.equal(store.accounts.used, 1);
});

test('service checkpoints use resource-only commits without enumerating account metadata', async t => {
  const f = await fixture(t), key = keyFor(88005);
  const service = new RemoteBrowserService({ root: f.directory, dataDirectory: f.directory, ownerConnector: null });
  try {
    await service.load();
    await service.commit(draft => {
      draft.pages.push(nativePage(key));
      draft.states.push(['unrelated', { revision: 1, values: {} }]);
    });
    service.pages.set(key, { ...nativePage(key), live: false });
    const snapshot = service.store.current;
    for (const field of ['pages', 'states', 'closedTabs']) Object.defineProperty(snapshot, field, {
      get() { throw Error('Checkpoint enumerated unrelated rows'); }, configurable: true,
    });
    const call = service.store.call.bind(service.store), operations = [];
    service.store.call = (op, args) => { operations.push(op); return call(op, args); };
    service.pages.get(key).url = 'https://checkpoint.example/updated';
    service.pages.get(key).zoom = 125;
    await service.persist([key]);
    assert.deepEqual(operations, ['commit']);
    assert.equal(service.store.account('owner').pages[0].url, 'https://checkpoint.example/updated');
    assert.equal(service.store.account('owner').pages[0].zoom, 125);
    assert.equal(service.store.account('unrelated').states[0][1].revision, 1);
  } finally { service.close(); await service.persistence; }
});

test('startup retirement prefetch excludes unrelated account metadata but later owner reads retain its fences', async t => {
  const f = await fixture(t), key = keyFor(89001), lease = JSON.parse(key)[1];
  const saved = empty();
  saved.retired.push(key);
  saved.retiredResources = [{ key, ownerId: 'owner', lease, pageIds: ['closed-page'], tabIds: ['closed-tab'] }];
  for (let index = 0; index < 1000; index++) saved.states.push(['metadata-' + index, { revision: 1,
    values: { storage: JSON.stringify({ ['page-' + index]: 'browser-unused-' + index }) } }]);
  saved.states.push(['owner', { revision: 1, values: { storage: JSON.stringify({ 'closed-page': lease }) } }]);
  await writeFile(join(f.directory, 'tabs.json'), JSON.stringify(saved));
  const store = new BrowserStateStore(f.directory), calls = [], call = store.call.bind(store);
  store.call = (op, args) => { if (op === 'select') calls.push(args); return call(op, args); };
  try {
    await store.open();
    assert.deepEqual(calls, [{ keys: [], owners: [] }]);
    const selected = await store.readRetirements('owner', { pages: ['closed-page'], tabs: [], leases: [] });
    assert.deepEqual(selected.references.pages, ['closed-page']);
    assert.deepEqual(selected.references.leases, [lease]);
    await store.transact(draft => {
      assert(draft.retired.includes(key));
      assert(draft.retiredResources.lookup('owner').leases.has(lease));
    }, { ownerId: 'owner' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].owners.map(([owner]) => owner), ['owner']);
  } finally { await store.close(); }
});

test('startup page validation indexes account rows once instead of searching per resource', async () => {
  const { validateBrowserState } = await import('../../scripts/remote-browser/state-validation.mjs');
  const saved = empty();
  for (let index = 0; index < 1000; index++) {
    const owner = 'owner-' + index, key = JSON.stringify([owner, 'browser-page']);
    saved.states.push([owner, { revision: 1, values: {} }]);
    saved.pages.push({ ...nativePage(key), ownerId: owner });
  }
  saved.states.find = () => { throw Error('Linear account lookup'); };
  assert.equal(validateBrowserState(saved).pages.length, 1000);
});

test('bulk session links parse each metadata field once and preserve scope and first-match authority', async () => {
  const { linkedSessions, sessionLink, sessionLinkIndex } = await import('../../scripts/remote-browser-state-file.mjs');
  const encoded = { storage: JSON.stringify({ first: 'browser:shared', second: 'browser-shared', mismatch: 'browser-mismatch', missing: 'browser-missing' }),
    pages: JSON.stringify([{ id: 'first', ownerId: 'scope', hostId: 'host', entries: [{ url: 'https://first.example' }], index: 0 },
      { id: 'second', ownerId: 'scope' }, { id: 'mismatch', ownerId: 'scope' }]),
    tabs: JSON.stringify([{ id: 'tab-first', pageId: 'first', ownerId: 'scope' }, { id: 'tab-second', pageId: 'second', ownerId: 'scope' },
      { id: 'tab-wrong-scope', pageId: 'mismatch', ownerId: 'foreign' }, { id: 'tab-later-correct', pageId: 'mismatch', ownerId: 'scope' }]) };
  const counts = {}, values = {};
  for (const [key, value] of Object.entries(encoded)) Object.defineProperty(values, key, { get() { counts[key] = (counts[key] ?? 0) + 1; return value; } });
  const sessions = linkedSessions('account', { values });
  assert.deepEqual(counts, { storage: 1, pages: 1, tabs: 1 });
  assert.equal(sessions.length, 1, 'lease aliases must not duplicate the directory');
  assert.equal(sessions[0].url, 'https://first.example');
  assert.deepEqual(sessions[0].link, sessionLink({ values: encoded }, 'browser-shared'));
  assert(!sessionLinkIndex({ values: encoded }).has('browser-mismatch'));
  assert(!sessionLinkIndex({ values: encoded }).has('browser-missing'));
  for (const value of [null, 'not-json', '[]']) assert.equal(linkedSessions('account', { values: { storage: value } }).length, 0);
  const blocked = { values: { storage: '{"first":"browser-first"}', pages: '[null,{"id":"first","ownerId":"scope"}]',
    tabs: '[{"id":"tab","pageId":"first","ownerId":"scope"}]' } };
  assert.equal(sessionLink(blocked, 'browser-first'), null);
  assert.equal(linkedSessions('account', blocked).length, 0);
});

test('legacy resource validation builds each owner link index once without retaining mutable drafts', async () => {
  const { validateBrowserState } = await import('../../scripts/remote-browser/state-validation.mjs');
  const { linkedSessions } = await import('../../scripts/remote-browser-state-file.mjs');
  const saved = empty(), pages = [], tabs = [], storage = {};
  for (let index = 0; index < 1000; index++) {
    const key = keyFor(90000 + index), pageId = 'page-' + index;
    saved.pages.push(nativePage(key));
    pages.push({ id: pageId, ownerId: 'scope' }); tabs.push({ id: 'tab-' + index, pageId, ownerId: 'scope' });
    storage[pageId] = JSON.parse(key)[1];
  }
  const encoded = { storage: JSON.stringify(storage), pages: JSON.stringify(pages), tabs: JSON.stringify(tabs) }, counts = {}, values = {};
  for (const [key, value] of Object.entries(encoded)) Object.defineProperty(values, key, { get() { counts[key] = (counts[key] ?? 0) + 1; return value; } });
  saved.states.push(['owner', { revision: 1, values }]);
  validateBrowserState(saved);
  assert.deepEqual(counts, { storage: 1, pages: 1, tabs: 1 });
  assert.equal(saved.pages[999].link.tabId, 'tab-999');
  const mutable = { values: { ...encoded } };
  assert.equal(linkedSessions('owner', mutable).length, 1000);
  mutable.values.storage = '{}';
  assert.deepEqual(linkedSessions('owner', mutable), [], 'a new operation cannot reuse stale draft links');
});

for (const [label, options] of [['global', undefined], ['account', { ownerId: 'owner' }], ['resource', { resourcesOnly: true }]]) {
  test(`${label} publication uses committed bytes despite live-object and retained-draft mutations during acknowledgement`, async t => {
    const f = await fixture(t), store = await f.open(), key = keyFor(91001);
    await store.transact(draft => { draft.pages.push({ ...nativePage(key), viewport: { width: 800, height: 600 } }); });
    const call = store.call.bind(store);
    let release, entered, retained;
    const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
    store.call = async (op, args) => { if (op === 'commit') { entered(); await gate; } return call(op, args); };
    const viewport = { width: 1024, height: 768 };
    const transaction = store.transact(draft => {
      retained = draft;
      draft.pages[0].viewport = viewport;
      draft.pages[0].runtime.kind = 'unknown';
    }, options);
    await waiting;
    viewport.width = 9999;
    retained.pages[0].runtime.kind = 'absent';
    retained.pages[0].url = 'https://uncommitted.example/';
    release(); await transaction;
    const row = store.account('owner').pages[0];
    assert.equal(row.viewport.width, 1024);
    assert.equal(row.runtime.kind, 'unknown');
    assert.equal(row.url, undefined);
    assert.equal(store.accounts.used, 1);
    retained.pages[0].viewport.height = 9999;
    assert.equal(row.viewport.height, 768, 'retained draft must stay detached after commit');
    const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
    try { assert.deepEqual(row, JSON.parse(db.prepare('SELECT value FROM browser_pages WHERE key=?').get(key).value)); }
    finally { db.close(); }
  });
}

test('retirement publication detaches retained fact identities before awaiting the Worker', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(91002), lease = JSON.parse(key)[1];
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  const call = store.call.bind(store);
  store.call = async (op, args) => { if (op === 'commit') { entered(); await gate; } return call(op, args); };
  const fact = { key, ownerId: 'owner', lease, pageIds: ['committed-page'], tabIds: ['committed-tab'] };
  const transaction = store.transact(draft => { draft.retiredResources.push(fact); }, { ownerId: 'owner', keys: [key] });
  await waiting;
  fact.pageIds.push('uncommitted-page'); fact.tabIds.push('uncommitted-tab');
  release(); await transaction;
  assert.deepEqual(store.current.retiredResources.get(key).pageIds, ['committed-page']);
  const selected = await store.readRetirements('owner', { pages: ['committed-page', 'uncommitted-page'], tabs: ['uncommitted-tab'], leases: [] });
  assert.deepEqual(selected.references.pages, ['committed-page']);
  assert.deepEqual(selected.references.tabs, []);
});

test('loaded runtime pages do not share nested objects with committed resource rows', async t => {
  const f = await fixture(t), options = { root: f.directory, dataDirectory: f.directory, ownerConnector: null }, key = keyFor(91003);
  const seed = new RemoteBrowserService(options);
  try {
    await seed.load();
    await seed.commit(draft => { draft.pages.push({ ...nativePage(key), viewport: { width: 800, height: 600 },
      link: { pageId: 'page', tabId: 'tab', scopeId: 'scope', hostId: 'host' } }); });
  } finally { seed.close(); await seed.persistence; }
  const service = new RemoteBrowserService(options);
  try {
    await service.load();
    const live = service.pages.get(key), durable = service.store.account('owner').pages[0];
    live.viewport.width = 1234; live.runtime.kind = 'unknown'; live.link.tabId = 'uncommitted-tab';
    assert.equal(durable.viewport.width, 800);
    assert.equal(durable.runtime.kind, 'absent');
    assert.equal(durable.link.tabId, 'tab');
    assert.equal(service.store.accounts.used, 0);
  } finally { service.close(); await service.persistence; }
});

test('a fatal Worker error fences already-queued writes and reads while allowing close', async t => {
  const f = await fixture(t), store = await f.open();
  const emptyChanges = () => ({ pages: { put: [], remove: [] }, states: { put: [], remove: [] }, closedTabs: { put: [], remove: [] } });
  const bad = emptyChanges(); bad.states.put.push(['rolled-back', JSON.stringify({ revision: 1, values: {} })]);
  const late = emptyChanges(); late.states.put.push(['must-not-commit', JSON.stringify({ revision: 2, values: {} })]);
  // Exercise the Worker protocol directly so main-thread failure cleanup cannot
  // hide a Worker which keeps executing messages already in its mailbox.
  const replies = new Map();
  const completed = new Promise(resolve => {
    const receive = message => {
      if (![ -101, -102, -103, -104 ].includes(message.id)) return;
      replies.set(message.id, message);
      if (replies.size === 4) { store.worker.off('message', receive); resolve(); }
    };
    store.worker.on('message', receive);
  });
  store.worker.postMessage({ id: -101, op: 'commit', args: { changes: bad, facts: [{ invalid: true }] } });
  store.worker.postMessage({ id: -102, op: 'commit', args: { changes: late, facts: [] } });
  store.worker.postMessage({ id: -103, op: 'has', args: { key: keyFor(92001) } });
  store.worker.postMessage({ id: -104, op: 'close', args: {} });
  await completed;
  for (const id of [-101, -102, -103]) {
    assert.equal(replies.get(id).error.fatal, true);
    assert.equal(replies.get(id).error.outcome, 'unknown');
    assert.equal(replies.get(id).error.message, 'Invalid browser retirement identity');
  }
  assert.equal(replies.get(-104).error, undefined);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM browser_metadata').get().n, 0); }
  finally { db.close(); }
});

test('selected resource checkpoints do not enumerate global or unrelated account rows', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(89001), other = keyFor(89002);
  const foreign = JSON.stringify(['foreign', 'browser-' + 'a'.repeat(64)]);
  await store.transact(draft => { draft.pages.push(nativePage(key), nativePage(other), { ...nativePage(foreign), ownerId: 'foreign' }); });
  const unrelated = store.account('owner').pages.find(page => page.key === other);
  Object.defineProperty(unrelated, 'unrelatedRead', { enumerable: true, get() { throw Error('Checkpoint cloned another resource'); } });
  Object.defineProperty(store.current, 'pages', { configurable: true, get() { throw Error('Checkpoint enumerated global pages'); } });
  const calls = [], call = store.call.bind(store);
  store.call = (op, args) => { calls.push({ op, args }); return call(op, args); };
  await store.transact(draft => { assert.equal(draft.pages.length, 1); draft.pages[0].zoom = 125; }, { resourcesOnly: true, resourceKeys: [key, key] });
  assert.deepEqual(calls.map(c => c.op), ['commit']);
  assert.deepEqual(calls[0].args.changes.pages.put.map(([key]) => key), [key]);
  assert.equal(store.account('owner').pages.find(page => page.key === key).zoom, 125);
  assert.equal(store.account('foreign').pages[0].key, foreign);
  assert.equal(store.accounts.used, 0);
});

test('selected resource keys are captured before queueing and cannot expand the reducer read set', async t => {
  const f = await fixture(t), store = await f.open(), key = keyFor(89003), other = keyFor(89004);
  await store.transact(draft => { draft.pages.push(nativePage(key), nativePage(other)); });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = store.enqueue(() => gate), keys = [key];
  const selected = store.transact(draft => { assert.deepEqual(draft.pages.map(page => page.key), [key]); draft.pages[0].zoom = 150; }, { resourcesOnly: true, resourceKeys: keys });
  keys[0] = other; release(); await held; await selected;
  const snapshot = store.current;
  await assert.rejects(store.transact(draft => { draft.pages.push(nativePage(other)); }, { resourcesOnly: true, resourceKeys: [key] }), /existing resources/);
  assert.equal(store.current, snapshot);
  await store.transact(draft => { draft.pages = draft.pages.filter(page => page.key !== key); }, { ownerId: 'owner' });
  await store.transact(draft => { assert.equal(draft.pages.length, 0); }, { resourcesOnly: true, resourceKeys: [key] });
  assert.equal(store.account('owner').pages.length, 1);
});

test('service checkpoints batch only changed resource identities', async t => {
  const service = new RemoteBrowserService({ root: '/unused', dataDirectory: '/unused', ownerConnector: null });
  t.after(() => service.close());
  const batches = []; let delivered;
  const saved = new Promise(resolve => { delivered = resolve; });
  service.persist = async keys => { batches.push(keys); delivered(); };
  service.checkpoint(keyFor(89005)); service.checkpoint(keyFor(89006)); service.checkpoint(keyFor(89005));
  // Keep the event loop alive independently of the service's unref'd timer.
  const deadline = setTimeout(() => delivered(), 2000);
  await saved; clearTimeout(deadline);
  assert.deepEqual(batches, [[keyFor(89005), keyFor(89006)]]);
});

test('service close returns its shared Worker-drain barrier and releases the writer before resolving', async t => {
  const f = await fixture(t), options = { root: f.directory, dataDirectory: f.directory, ownerConnector: null };
  const service = new RemoteBrowserService(options);
  await service.load();
  const closeWorker = service.store.close.bind(service.store);
  let release, entered, settled = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  service.store.close = async () => { entered(); await gate; await closeWorker(); };
  const closing = service.close();
  assert.equal(service.close(), closing);
  closing.then(() => { settled = true; });
  await started;
  assert.equal(settled, false);
  const competitor = new RemoteBrowserService(options);
  try { await assert.rejects(competitor.load(), { code: 'BROWSER_UNAVAILABLE', retryable: true }); }
  finally { await competitor.close(); }
  release(); await closing;
  assert.equal(service.store.closed, true);
  const successor = new RemoteBrowserService(options);
  try { await successor.load(); }
  finally { await successor.close(); }
});
