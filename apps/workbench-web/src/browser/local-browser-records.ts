import type { BrowserMetadataStorage, BrowserRecordPort, BrowserRecordCollection, BrowserMetadataRecord } from './desktop-browser-storage';
import { openClientResourcePersistence } from '../runtime/client-resource-persistence';
import { browserMetadataKeys, readBrowserMetadataValue } from '@opencraft/workbench-runtime/browser-metadata-identity';
import { serverStorageKey } from '../runtime/server-context';
import type { ClientResourcePersistence, ClientResourceKey } from '@opencraft/document-storage/client-resources';
const fields = { pages: browserMetadataKeys.pages, tabs: browserMetadataKeys.tabs, storage: browserMetadataKeys.storage, bindings: browserMetadataKeys.bindings } as const;
const collections = Object.keys(fields) as BrowserRecordCollection[];
/** Synchronous UI projection over the existing IndexedDB / Main SQLite row port.
 * A mutation writes one resource, never an index or a serialized directory. */
export async function createLocalBrowserStorage(options: {
    backend?: ClientResourcePersistence;
    namespace?: string;
    legacy?: () => Promise<Record<string, string>>;
} = {}): Promise<BrowserMetadataStorage> {
    const namespace = options.namespace ?? serverStorageKey('opencraft.browser-records.v2');
    const backend = options.backend ?? await openClientResourcePersistence(namespace);
    const resource = (collection: string, id: string): ClientResourceKey => ({ namespace, name: collection, id, authority: 'local' });
    const marker = resource('migration', 'metadata-v1');
    if (!await backend.read(marker)) {
        const legacy = options.legacy ? await options.legacy() : Object.fromEntries(collections.map(collection => {
            const key = fields[collection], scope = collection === 'bindings' ? serverStorageKey : (s: string) => s;
            let value: string | null = null;
            try {
                value = readBrowserMetadataValue(localStorage, key, scope);
            }
            catch { }
            return [key, value ?? (collection === 'storage' ? '{}' : '[]')];
        }));
        for (const collection of collections) {
            const parsed = JSON.parse(legacy[fields[collection]] ?? (collection === 'storage' ? '{}' : '[]'));
            const entries: [
                string,
                any
            ][] = collection === 'storage' ? Object.entries(parsed) : parsed.map((row: any) => [collection === 'bindings' ? row.scopeId : row.id, row]);
            for (const [id, value] of entries) {
                if (typeof id !== 'string' || !id)
                    continue;
                const key = resource(collection, id), existing = await backend.read(key);
                // Resume interrupted imports without replacing an already committed row.
                if (!existing && !await backend.compareAndSet(key, 0, { version: 1, savedAt: Date.now(), value }))
                    throw new Error('Browser record migration conflicted');
            }
        }
        if (!await backend.compareAndSet(marker, 0, { version: 1, savedAt: Date.now(), value: { imported: true } }) && !await backend.read(marker))
            throw new Error('Browser record migration could not commit');
    }
    const values = new Map<BrowserRecordCollection, Map<string, BrowserMetadataRecord>>(), versions = new Map<string, number>();
    const tabsByPage = new Map<string, Set<string>>(), pending = new Map<string, Promise<void>>();
    let closed = false;
    const map = (collection: BrowserRecordCollection) => { let result = values.get(collection); if (!result) {
        result = new Map();
        values.set(collection, result);
    } return result; };
    const remember = (row: BrowserMetadataRecord) => {
        const current = map(row.collection).get(row.id);
        if (row.collection === 'tabs') {
            if (current?.value?.pageId)
                tabsByPage.get(current.value.pageId)?.delete(row.id);
            if (row.value?.pageId) {
                const set = tabsByPage.get(row.value.pageId) ?? new Set<string>();
                set.add(row.id);
                tabsByPage.set(row.value.pageId, set);
            }
        }
        map(row.collection).set(row.id, row);
    };
    for (const collection of collections)
        for (const key of await backend.listLocalKeys(namespace, collection)) {
            const row = await backend.read(key);
            if (!row)
                continue;
            remember({ collection, id: key.id, revision: row.revision, value: row.value });
            versions.set(JSON.stringify([collection, key.id]), row.revision);
        }
    const write = (collection: BrowserRecordCollection, id: string, value: any) => {
        if (closed)
            throw new Error('Browser resource storage closed');
        const bytes = JSON.stringify(value), key = JSON.stringify([collection, id]), old = map(collection).get(id);
        if (old && JSON.stringify(old.value) === bytes)
            return;
        const immutable = JSON.parse(bytes);
        remember({ collection, id, revision: old?.revision ?? 0, value: immutable });
        const job = (pending.get(key) ?? Promise.resolve()).then(async () => {
            const revision = versions.get(key) ?? 0;
            if (!await backend.compareAndSet(resource(collection, id), revision, { version: 1, savedAt: Date.now(), value: immutable }))
                throw Object.assign(new Error('Browser resource changed in another client'), { code: 'STATE_CONFLICT' });
            versions.set(key, revision + 1);
        });
        pending.set(key, job);
        void job.then(() => { if (pending.get(key) === job)
            pending.delete(key); }, () => { });
    };
    const records: BrowserRecordPort = {
        rows: collection => [...map(collection).values()].filter(r => r.value !== null), get: (collection, id) => map(collection).get(id) ?? null,
        put: write, remove: (collection, id) => write(collection, id, null),
        flush: refs => Promise.all(refs ? refs.map(ref => pending.get(JSON.stringify([ref.collection, ref.id])) ?? Promise.resolve()) : [...pending.values()]).then(() => { }),
        flushPage: pageId => records.flush([{ collection: 'pages', id: pageId }, { collection: 'storage', id: pageId }, ...[...(tabsByPage.get(pageId) ?? [])].map(id => ({ collection: 'tabs' as const, id }))]),
    };
    return {
        records,
        getItem(key) { const collection = collections.find(c => fields[c] === key || serverStorageKey(fields[c]) === key); if (!collection)
            return null; const rows = records.rows(collection); return JSON.stringify(collection === 'storage' ? Object.fromEntries(rows.map(r => [r.id, r.value])) : rows.map(r => r.value)); },
        setItem() { throw new Error('Browser resource snapshots are read-only; use entity mutations'); },
        flush: () => records.flush(),
        async dispose() { if (closed)
            return; closed = true; let timer: ReturnType<typeof setTimeout> | undefined; try {
            await Promise.race([records.flush(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
        }
        finally {
            clearTimeout(timer);
            await backend.close();
        } },
    };
}
