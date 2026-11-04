import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { createConversationBindingStore, asConversationScopeId } from '../../packages/workbench-runtime/src/conversation-binding';
import { asHostId, createConversationKey } from '@opencraft/chat-core';
async function fixture(t: any, legacy?: any) {
    const directory = await mkdtemp(join(tmpdir(), 'browser-records-'));
    if (legacy) {
        await mkdir(join(directory, 'remote-browser'), { recursive: true });
        await writeFile(join(directory, 'remote-browser/tabs.json'), JSON.stringify(legacy));
    }
    const service = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    let loseAck = false, dropRead = false;
    const messages: any[] = [];
    let wireBytes = 0;
    server.on('connection', socket => socket.on('message', async (bytes) => {
        const m = JSON.parse(String(bytes));
        messages.push(m);
        wireBytes += bytes.length;
        try {
            if (dropRead && m.input?.action === 'read') {
                dropRead = false;
                socket.close(1012);
                return;
            }
            const value = m.method === 'records' ? await service.recordCommand('actor', m.input, () => { }) : await service.metadata('actor', m.input, () => { });
            if (loseAck && m.input?.mutationId) {
                loseAck = false;
                socket.close(1012);
                return;
            }
            socket.send(JSON.stringify({ type: 'result', id: m.id, value }));
        }
        catch (error: any) {
            socket.send(JSON.stringify({ type: 'result', id: m.id, error: { message: error.message, code: error.code, retryable: error.retryable === true } }));
        }
    }));
    const saved = new Map(['WebSocket', 'location', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries({ WebSocket, location: { href: `http://127.0.0.1:${(server.address() as any).port}/` }, localStorage: { getItem() { return null; } } }))
        Object.defineProperty(globalThis, key, { configurable: true, value });
    const storages: any[] = [];
    const open = async () => { const s = await RemoteBrowserStorage.create(); storages.push(s); return s; };
    t.after(async () => { for (const storage of storages)
        storage.dispose(); for (const socket of server.clients)
        socket.terminate(); service.close(); await service.persistence; await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); for (const [key, value] of saved)
        value ? Object.defineProperty(globalThis, key, value) : delete (globalThis as any)[key]; });
    return { directory, service, open, messages, get wireBytes() { return wireBytes; }, lose() { loseAck = true; }, dropRead() { dropRead = true; } };
}
const alias = (id: string, threadId: string | null = null) => ({ scopeId: id, hostId: 'host', threadId });
test('v1 migration preserves every identity, fences legacy writers, pages aliases, and cold restart uses committed SQLite', async (t) => {
    const bindings = Array.from({ length: 600 }, (_, i) => alias('draft-' + i, 'thread-' + i));
    const legacy = { schemaVersion: 1, pages: [], retired: [], states: [['actor', { revision: 7, keyRevisions: { bindings: 7 }, values: { bindings: JSON.stringify(bindings) } }]] };
    const f = await fixture(t, legacy), storage = await f.open();
    assert.equal(storage.records.rows('bindings').length, 600);
    assert.equal(f.messages.filter(m => m.input?.action === 'list').length, 2);
    const fence = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(fence.schemaVersion, 2);
    const backups = (await readdir(join(f.directory, 'remote-browser'))).filter(p => p.startsWith('tabs-v1-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.directory, 'remote-browser', backups[0]), 'utf8'), JSON.stringify(legacy));
    await assert.rejects(f.service.metadata('actor', { scope: (storage as any).scope, key: 'bindings', value: '[]', expectedKeyRevision: 7, mutationId: randomUUID() }, () => { }), { code: 'PROTOCOL_UPGRADE_REQUIRED' });
    storage.records.put('bindings', 'new-draft', alias('new-draft', 'new-thread'));
    await storage.records.flush();
    const count = f.service.store.db.prepare("SELECT count(*) n FROM resource_records WHERE owner='actor' AND collection='bindings' AND value IS NOT NULL").get().n;
    assert.equal(Number(count), 601);
    const repository = (await import('../../scripts/remote-browser-records.mjs')).BrowserRecordRepository;
    // An independent read of the committed database cannot fall back to the legacy bytes.
    const reopened = new repository(join(f.directory, 'remote-browser/resources.sqlite'), { schemaVersion: 1, pages: [], retired: [], states: [] }, fence.legacyDigest, true);
    try {
        assert.deepEqual(reopened.get('actor', 'bindings', 'new-draft').value, alias('new-draft', 'new-thread'));
        assert.equal(reopened.outcome.status, 'up-to-date');
    }
    finally {
        reopened.close();
    }
});
test('single-entity conflicts do not block a peer entity and replayed acknowledged commands cannot overwrite newer values', async (t) => {
    const f = await fixture(t), a = await f.open(), b = await f.open();
    a.records.put('bindings', 'same', alias('same'));
    await a.records.flush();
    // Both clients read the same row revision before racing a promotion.
    const current = f.service.store.get('actor', 'bindings', 'same');
    const scope = (a as any).scope;
    const command = { collection: 'bindings', id: 'same', value: alias('same', 'one'), expectedRevision: current.revision, mutationId: randomUUID(), scope };
    await f.service.recordCommand('actor', command, () => { });
    await assert.rejects(f.service.recordCommand('actor', { ...command, value: alias('same', 'two'), mutationId: randomUUID() }, () => { }), { code: 'STATE_CONFLICT' });
    assert.equal((await f.service.recordCommand('actor', command, () => { })).revision, 2);
    await assert.rejects(f.service.recordCommand('actor', { ...command, value: alias('same', 'two') }, () => { }), { code: 'OPERATION_CONFLICT' });
    b.records.put('bindings', 'independent', alias('independent', 'peer'));
    await b.records.flush();
    assert.deepEqual(f.service.store.get('actor', 'bindings', 'independent').value, alias('independent', 'peer'));
    assert.equal(f.service.store.get('other', 'bindings', 'same'), null);
});
test('lost reads and lost committed ACK retry one entity without resending a full directory', async (t) => {
    const f = await fixture(t), storage = await f.open();
    f.dropRead();
    f.lose();
    storage.records.put('bindings', 'retry', alias('retry', 'thread'));
    await storage.records.flush();
    const writes = f.messages.filter(m => m.input?.mutationId);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].input, writes[1].input);
    assert.equal(f.service.store.get('actor', 'bindings', 'retry').revision, 1);
    assert(f.messages.every(m => m.method === 'records'));
    assert(f.messages.every(m => !m.input || m.input.key === undefined));
});
test('draft promotion commits direct Thread ownership with its browser relationship, and failed relation updates roll back', async (t) => {
    const f = await fixture(t), s = await f.open();
    const lease = 'browser-' + randomUUID();
    s.records.put('bindings', 'draft', alias('draft'));
    s.records.put('pages', 'page', { id: 'page', ownerId: 'draft', hostId: 'host', entries: [], index: -1 });
    s.records.put('tabs', 'tab', { id: 'tab', ownerId: 'draft', pageId: 'page' });
    s.records.put('storage', 'page', lease);
    await s.records.flush();
    assert.deepEqual((await f.service.catalog('actor', () => { })).sessions[0].link.ownerRef, { kind: 'draft', draftId: 'draft' });
    const save = f.service.store.saveSession;
    f.service.store.saveSession = () => { throw new Error('Injected relation failure'); };
    const scope = (s as any).scope, command = { scope, collection: 'bindings', id: 'draft', value: alias('draft', 'thread'), expectedRevision: 1, mutationId: randomUUID() };
    await assert.rejects(f.service.recordCommand('actor', command, () => { }), /Injected relation failure/);
    assert.equal(f.service.store.get('actor', 'bindings', 'draft').value.threadId, null);
    f.service.store.saveSession = save;
    await f.service.recordCommand('actor', command, () => { });
    assert.deepEqual((await f.service.catalog('actor', () => { })).sessions[0].link.ownerRef, { kind: 'thread', hostId: 'host', threadId: 'thread' });
    assert.equal(f.service.pages.size, 1);
    assert.equal([...f.service.pages.values()][0].live, false, 'logical ownership cannot create a native runtime');
});
test('entity tombstones fence delayed resurrection even after command receipt compaction', async (t) => {
    const f = await fixture(t), s = await f.open(), scope = (s as any).scope;
    const command = { scope, collection: 'bindings', id: 'closed', value: alias('closed'), expectedRevision: 0, mutationId: randomUUID() };
    await f.service.recordCommand('actor', command, () => { });
    await f.service.recordCommand('actor', { ...command, value: null, expectedRevision: 1, mutationId: randomUUID() }, () => { });
    for (let i = 0; i < 260; i++)
        await f.service.recordCommand('actor', { ...command, id: 'other-' + i, value: alias('other-' + i), mutationId: randomUUID() }, () => { });
    await assert.rejects(f.service.recordCommand('actor', command, () => { }), { code: 'STATE_CONFLICT' });
    assert.equal(f.service.store.get('actor', 'bindings', 'closed').value, null);
});
test('ten thousand binding additions use entity writes and precise notifications without snapshot serialization', () => {
    let bytes = 0, writes = 0, unrelated = 0, target = 0;
    const store = createConversationBindingStore({ persistence: { save() { throw Error('Full snapshots forbidden'); }, records: { load: () => [], put(value) { bytes += JSON.stringify(value).length; writes++; }, remove() { writes++; } } } });
    const watched = asConversationScopeId('draft-0');
    store.subscribeScope(watched, () => target++);
    store.subscribeScope(asConversationScopeId('unrelated'), () => unrelated++);
    for (let i = 0; i < 10000; i++) {
        const id = asConversationScopeId('draft-' + i);
        store.register(id, asHostId('host'));
        store.bind(id, createConversationKey('host', 'thread-' + i));
    }
    assert.equal(writes, 20000);
    assert(bytes < 3000000);
    assert.equal(target, 2);
    assert.equal(unrelated, 0);
    const before = writes;
    const canonical = asConversationScopeId('conversation:' + JSON.stringify(['host', 'existing']));
    store.register(canonical, asHostId('host'), { persistent: false });
    store.bind(canonical, createConversationKey('host', 'existing'));
    assert.equal(writes, before);
    assert.equal(store.getSnapshot().bindings.length, 10001);
    store.dispose();
});
test('network bytes and SQLite writes grow with changed records, not with retained alias directory size', async (t) => {
    const f = await fixture(t), s = await f.open();
    // Seed unrelated history once; prohibit its enumeration in the mutation path.
    await f.service.commit(store => { for (let i = 0; i < 10000; i++)
        store.put('actor', 'bindings', 'old-' + i, alias('old-' + i, 'thread-' + i)); });
    const all = f.service.store.all.bind(f.service.store);
    f.service.store.all = (owner: string, collection: string) => { assert.notEqual(collection, 'bindings', 'mutation enumerated the directory'); return all(owner, collection); };
    const beforeBytes = f.wireBytes, beforeChanges = Number(f.service.store.db.prepare('SELECT total_changes() n').get().n);
    for (let i = 0; i < 200; i++)
        s.records.put('bindings', 'new-' + i, alias('new-' + i, 'new-thread-' + i));
    await s.records.flush();
    const changes = Number(f.service.store.db.prepare('SELECT total_changes() n').get().n) - beforeChanges;
    assert(changes <= 800, `too many row changes: ${changes}`);
    assert(f.wireBytes - beforeBytes < 200 * 1024, `too many transmitted bytes: ${f.wireBytes - beforeBytes}`);
});
test('deleting a resource durably retires its session and cannot resurrect it on retry', async (t) => {
    const f = await fixture(t), storage = await f.open();
    storage.records.put('bindings', 'draft', alias('draft'));
    storage.records.put('pages', 'page', { id: 'page', ownerId: 'draft', hostId: 'host', entries: [], index: -1 });
    storage.records.put('tabs', 'tab', { id: 'tab', pageId: 'page', ownerId: 'draft', createdAt: 1 });
    storage.records.put('storage', 'page', 'browser-test');
    await storage.records.flush();
    const key = JSON.stringify(['actor', 'browser-test']);
    assert.equal(f.service.store.session(key).lifecycle, 'open');
    storage.records.remove('tabs', 'tab');
    await storage.records.flush();
    assert.equal(f.service.store.retired(key), true);
    assert.equal(f.service.store.session(key).closing, true);
    storage.records.put('tabs', 'tab', { id: 'tab', pageId: 'page', ownerId: 'draft', createdAt: 1 });
    await assert.rejects(storage.records.flush(), error => ['STATE_CONFLICT', 'SESSION_CLOSED'].includes((error as any).code));
    assert.equal(f.service.store.session(key).closing, true);
    for (const [collection,id] of [['pages','page'],['storage','page'],['tabs','tab']])
        assert.equal(f.service.store.get('actor',collection,id).value,null);
});
test('canonical Thread ownership resolves after reload without storing a permanent alias', () => {
    const store = createConversationBindingStore();
    const scope = asConversationScopeId('conversation:' + JSON.stringify(['host', 'thread']));
    const first = store.resolve(scope);
    assert.equal(first?.conversationKey?.threadId, 'thread');
    assert.equal(store.resolve(scope), first);
    assert.equal(store.getSnapshot().bindings.length, 0);
    const draft = asConversationScopeId('draft');
    store.register(draft, asHostId('host'));
    store.bind(draft, createConversationKey('host', 'thread'));
    assert.equal(store.findScope(createConversationKey('host', 'thread')), draft);
    assert.equal(store.resolve(scope), first);
    store.dispose();
});

test('interrupted imports roll back all rows; divergent v1 sources and missing v2 receipts fail closed',async t=>{
 const {BrowserRecordRepository}=await import('../../scripts/remote-browser-records.mjs');
 const dir=await mkdtemp(join(tmpdir(),'browser-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'resources.sqlite'),empty={schemaVersion:1,pages:[],states:[],retired:[]};
 assert.throws(()=>new BrowserRecordRepository(path,{...empty,states:[['actor',{values:{bindings:JSON.stringify([alias('good'),{scopeId:null}])}}]]}),/identity/);
 const store=new BrowserRecordRepository(path,empty);
 try{assert.equal(store.all('actor','bindings').length,0);}finally{store.close();}
 assert.throws(()=>new BrowserRecordRepository(path,{...empty,states:[['actor',{values:{bindings:'[]'}}]]}),/diverged/);
 const canonical=join(dir,'missing.sqlite');assert.throws(()=>new BrowserRecordRepository(canonical,empty,'unused',true),/missing its import receipt/);
});

test('closing one tab reference keeps its shared page until the final tab closes', async t => {
    const f = await fixture(t), storage = await f.open();
    storage.records.put('pages', 'shared', { id: 'shared', ownerId: 'draft', entries: [], index: -1 });
    storage.records.put('tabs', 'first', { id: 'first', pageId: 'shared', ownerId: 'draft' });
    storage.records.put('tabs', 'second', { id: 'second', pageId: 'shared', ownerId: 'draft' });
    storage.records.put('storage', 'shared', 'browser-shared');
    await storage.records.flush();
    const key = JSON.stringify(['actor', 'browser-shared']);
    storage.records.remove('tabs', 'first'); await storage.records.flush();
    assert.equal(f.service.store.retired(key), false);
    assert.equal(f.service.store.session(key).lifecycle, 'open');
    assert(f.service.store.get('actor', 'pages', 'shared').value);
    storage.records.remove('tabs', 'second'); await storage.records.flush();
    assert.equal(f.service.store.retired(key), true);
    for (const [collection,id] of [['pages','shared'],['storage','shared'],['tabs','second']])
        assert.equal(f.service.store.get('actor', collection, id).value, null);
});

for (const removed of ['pages', 'storage']) test(`removing ${removed} clears every recovery projection even after its lease index disappears`, async t => {
    const f = await fixture(t), storage = await f.open();
    storage.records.put('pages', 'page', { id: 'page', ownerId: 'draft', entries: [], index: -1 });
    storage.records.put('tabs', 'tab', { id: 'tab', pageId: 'page', ownerId: 'draft' });
    storage.records.put('storage', 'page', 'browser-forgotten');
    await storage.records.flush();
    storage.records.remove(removed as any, 'page'); await storage.records.flush();
    assert.equal(f.service.store.retired(JSON.stringify(['actor', 'browser-forgotten'])), true);
    for (const [collection,id] of [['pages','page'],['storage','page'],['tabs','tab']])
        assert.equal(f.service.store.get('actor', collection, id).value, null);
});
