import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { WorkbenchRecordStore, recordError } from '@opencraft/workbench-storage-node';
import { browserMetadataValueLimit } from '@opencraft/browser-core/metadata-limits';
const collections = new Set(['pages', 'tabs', 'storage', 'bindings']);
const entries = (collection, value) => collection === 'storage' ? Object.entries(value)
    : value.map(row => [collection === 'bindings' ? row.scopeId : row.id, row]);
const serialized = (collection, rows) => JSON.stringify(collection === 'storage' ? Object.fromEntries(rows.map(r => [r.id, r.value])) : rows.map(r => r.value));
const hash = value => createHash('sha256').update(value).digest('hex');
export class BrowserRecordRepository extends WorkbenchRecordStore {
    constructor(path, saved, digest = hash(JSON.stringify(saved)), canonical = false) {
        super(path);
        try {
        if (canonical && !this.imported('tabs-json-v1')) {
            this.close();
            throw new Error('Canonical browser database is missing its import receipt');
        }
        const imported = this.db.prepare('SELECT digest FROM resource_imports WHERE id=?').get('tabs-json-v1');
        if (imported && !canonical && imported.digest !== digest) {
            this.close();
            throw new Error('Legacy browser state diverged after migration; retained both sources');
        }
        this.import('tabs-json-v1', digest, () => {
            for (const record of saved.pages)
                this.put(record.ownerId, 'sessions', record.key, record);
            for (const key of saved.retired ?? [])
                this.put(JSON.parse(key)[0], 'retired', key, true);
            for (const [owner, state] of saved.states) {
                this.setLegacyHead(owner, { ...state, values: undefined, presentKeys: Object.keys(state.values ?? {}) });
                for (const [collection, bytes] of Object.entries(state.values ?? {})) {
                    if (!collections.has(collection))
                        throw new Error('Invalid browser record collection');
                    for (const [id, value] of entries(collection, JSON.parse(bytes))) {
                        if (typeof id !== 'string' || !id)
                            throw new Error('Invalid legacy browser record identity');
                        this.put(owner, collection, id, value, 1);
                    }
                }
            }
        });
        } catch(error) { this.close(); throw error; }
    }
    sessions(owner) {
        const rows = owner === undefined ? this.db.prepare("SELECT value FROM resource_records WHERE collection='sessions' AND value IS NOT NULL").all()
            : this.db.prepare("SELECT value FROM resource_records WHERE owner=? AND collection='sessions' AND value IS NOT NULL").all(owner);
        return rows.map(row => JSON.parse(row.value));
    }
    session(key) { return this.get(JSON.parse(key)[0], 'sessions', key)?.value ?? null; }
    saveSession(record) { this.put(record.ownerId, 'sessions', record.key, record); }
    deleteSession(key) { this.put(JSON.parse(key)[0], 'sessions', key, null); }
    retired(key) { return this.get(JSON.parse(key)[0], 'retired', key)?.value === true; }
    retire(key, removedPageIds = []) {
        const [owner, lease] = JSON.parse(key);
        if (!this.retired(key)) this.put(owner, 'retired', key, true);
        // Logical recovery and native retirement share the same transaction.
        // A cold tab can have metadata without ever owning a native page.
        const pages = this.db.prepare("SELECT id FROM resource_records WHERE owner=? AND collection='storage' AND lease_ref=? AND value IS NOT NULL").all(owner, lease);
        const changed = new Set();
        for (const id of new Set([...pages.map(page => page.id), ...removedPageIds])) {
            const tabs = this.db.prepare("SELECT id FROM resource_records WHERE owner=? AND collection='tabs' AND page_ref=? AND value IS NOT NULL").all(owner, id);
            for (const tab of tabs) { this.put(owner, 'tabs', tab.id, null); changed.add('tabs'); }
            for (const collection of ['pages', 'storage']) {
                if (this.get(owner, collection, id)?.value != null) { this.put(owner, collection, id, null); changed.add(collection); }
            }
        }
        if (changed.size) {
            const head = this.legacyHead(owner), keyRevisions = { ...head.keyRevisions };
            for (const collection of changed) {
                if (this.get(owner, 'legacy-values', collection)?.value != null) this.put(owner, 'legacy-values', collection, null);
                keyRevisions[collection] = (keyRevisions[collection] ?? 0) + 1;
            }
            this.setLegacyHead(owner, { ...head, revision: head.revision + 1, keyRevisions });
        }
    }
    assertOpenRecord(owner, collection, id, value) {
        if (value === null || collection === 'bindings') return;
        const previous = this.get(owner, collection, id);
        const page = collection === 'tabs' ? this.get(owner, 'pages', value?.pageId) : null;
        if (previous?.value === null || page?.value === null
            || collection === 'storage' && typeof value === 'string' && this.retired(JSON.stringify([owner, value.replace(':', '-')])))
            throw recordError('SESSION_CLOSED', 'Browser tab is closed');
    }
    retiredKeys() { return this.db.prepare("SELECT id FROM resource_records WHERE collection='retired' AND value IS NOT NULL").all().map(r => r.id); }
    snapshot(owner, includeBindings = true) {
        const head = this.legacyHead(owner), values = {};
        for (const collection of collections)
            if (includeBindings || collection !== 'bindings') {
                const rows = this.all(owner, collection), opaque = this.get(owner, 'legacy-values', collection)?.value;
                if (opaque !== undefined && opaque !== null)
                    values[collection] = opaque;
                else if (rows.length || head.presentKeys?.includes(collection) || head.keyRevisions?.[collection] !== undefined)
                    values[collection] = serialized(collection, rows);
            }
        return { ...head, values };
    }
    bootstrap(owner) {
        const records = {};
        for (const collection of ['pages', 'tabs', 'storage'])
            records[collection] = this.all(owner, collection);
        records.bindings = this.list(owner, 'bindings', '', 256);
        const aliasCursor = records.bindings.length === 256 ? records.bindings.at(-1).id : null;
        this.db.prepare('INSERT OR IGNORE INTO resource_imports(id,digest) VALUES(?,?)').run('protocol-v2:' + owner, 'activated');
        const importId = 'local-v1:' + owner;
        if (!this.imported(importId)) {
            const exists = this.db.prepare("SELECT 1 FROM resource_records WHERE owner=? AND collection IN ('pages','tabs','storage','bindings') LIMIT 1").get(owner);
            this.db.prepare('INSERT INTO resource_imports(id,digest) VALUES(?,?)').run(importId, exists ? 'disabled' : 'pending');
        }
        const legacyLocalImport = this.db.prepare('SELECT digest FROM resource_imports WHERE id=?').get(importId).digest === 'pending';
        return { protocol: 2, records, aliasCursor, legacyLocalImport };
    }
    link(owner, lease) {
        const storage = this.find(owner, 'storage', 'lease_ref', lease.replace(':', '-'));
        if (!storage)
            return null;
        const page = this.get(owner, 'pages', storage.id)?.value, tab = this.find(owner, 'tabs', 'page_ref', storage.id)?.value;
        if (!page || !tab || page.ownerId !== tab.ownerId)
            return null;
        const binding = this.get(owner, 'bindings', page.ownerId)?.value;
        let target = binding?.threadId ? { hostId: binding.hostId, threadId: binding.threadId } : null;
        if (!target && page.ownerId.startsWith('conversation:'))
            try {
                const [hostId, threadId] = JSON.parse(page.ownerId.slice(13));
                if (typeof hostId === 'string' && typeof threadId === 'string')
                    target = { hostId, threadId };
            }
            catch { }
        return { pageId: page.id, tabId: tab.id, scopeId: page.ownerId, hostId: target?.hostId ?? page.hostId ?? null, threadId: target?.threadId ?? null, ownerRef: target ? { kind: 'thread', ...target } : { kind: 'draft', draftId: page.ownerId } };
    }
    syncSession(owner, pageId) {
        const lease = this.get(owner, 'storage', pageId)?.value;
        if (typeof lease !== 'string')
            return;
        const key = JSON.stringify([owner, lease.replace(':', '-')]), link = this.link(owner, lease);
        if (!link || this.retired(key))
            return;
        const old = this.session(key), page = this.get(owner, 'pages', pageId)?.value;
        if (!old && this.sessions(owner).length >= 256)
            throw recordError('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached');
        this.saveSession(old ? { ...old, link } : { id: hash(key), key, ownerId: owner, link, lifecycle: 'open', version: 1, createdAt: Date.now(),
            url: page?.entries?.[page.index]?.url ?? null, zoom: 100, runtime: { kind: 'absent', generation: 0 } });
    }
    validate(collection, id, value, previous) {
        if (value === null)
            return;
        if (collection === 'bindings') {
            if (!value || value.scopeId !== id || typeof value.hostId !== 'string' || !(value.threadId === null || typeof value.threadId === 'string'))
                throw recordError('INVALID_RECORD', 'Invalid conversation binding');
            if (previous && (previous.hostId !== value.hostId || previous.threadId !== null && previous.threadId !== value.threadId))
                throw recordError('STATE_CONFLICT', 'Conversation binding is immutable');
        }
        else if (collection === 'storage') {
            if (typeof value !== 'string' || !/^browser[:-][a-zA-Z0-9-]+$/.test(value))
                throw recordError('INVALID_RECORD', 'Invalid browser partition');
        }
        else if (!value || value.id !== id || typeof value.ownerId !== 'string' || collection === 'tabs' && typeof value.pageId !== 'string')
            throw recordError('INVALID_RECORD', 'Invalid browser resource');
        if (JSON.stringify(value).length > 64 * 1024)
            throw recordError('STATE_TOO_LARGE', 'Browser resource record is too large');
    }
    mutation(owner, input) {
        if (!collections.has(input?.collection) || typeof input.id !== 'string' || !input.id || input.id.length > 2048
            || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-zA-Z0-9-]{20,100}$/.test(input.mutationId ?? ''))
            throw recordError('INVALID_RECORD', 'Invalid resource command');
        this.db.prepare("UPDATE resource_records SET value=NULL,revision=revision+1 WHERE owner=? AND collection='legacy-values' AND id=? AND value IS NOT NULL").run(owner, input.collection);
        const previous = this.get(owner, input.collection, input.id)?.value;
        const closingPage = input.value === null && previous !== null && previous !== undefined
            ? (input.collection === 'tabs' ? previous.pageId : ['pages', 'storage'].includes(input.collection) ? input.id : null) : null;
        const closingLease = closingPage ? this.get(owner, 'storage', closingPage)?.value : null;
        let result;
        try {
            result = this.mutate(owner, input, (old, next) => {
                this.validate(input.collection, input.id, next, old);
                this.assertOpenRecord(owner, input.collection, input.id, next);
            });
        } catch (error) {
            // A stale client may encounter retirement at its metadata fence,
            // before it can reach the native open RPC. Preserve that terminal
            // cause while keeping ordinary live-record CAS conflicts distinct.
            if (error.code === 'STATE_CONFLICT') this.assertOpenRecord(owner, input.collection, input.id, input.value);
            throw error;
        }
        if (input.collection === 'bindings' && input.value?.threadId) {
            const pages = this.db.prepare("SELECT id FROM resource_records WHERE owner=? AND collection='pages' AND scope_ref=? AND value IS NOT NULL").all(owner, input.id);
            for (const page of pages)
                this.syncSession(owner, page.id);
        }
        if (input.collection !== 'bindings') {
            const pageId = input.collection === 'tabs' ? input.value?.pageId : this.get(owner, input.collection, input.id)?.id;
            if (pageId)
                this.syncSession(owner, pageId);
        }
        const retiring = [];
        if (typeof closingLease === 'string' && !(input.collection === 'tabs' && this.find(owner, 'tabs', 'page_ref', closingPage))) {
            const key = JSON.stringify([owner, closingLease.replace(':', '-')]), session = this.session(key);
            this.retire(key, [closingPage]);
            if (session) {
                this.saveSession({ ...session, lifecycle: 'closing', closing: true, runtime: { ...session.runtime, kind: 'stopping' } });
            }
            retiring.push(key);
        }
        return { ...result, retiring };
    }
    legacyMutation(owner, input) {
        if (this.imported('protocol-v2:' + owner))
            throw recordError('PROTOCOL_UPGRADE_REQUIRED', 'Reload OpenCraft to update browser resource protocol');
        const previous = this.snapshot(owner), head = this.legacyHead(owner);
        if (!collections.has(input.key) || typeof input.value !== 'string' || input.value.length > browserMetadataValueLimit(input.key)
            || !/^[a-zA-Z0-9-]{20,100}$/.test(input.mutationId ?? ''))
            throw new Error('Invalid browser metadata');
        const fingerprint = hash(JSON.stringify([input.key, input.value]));
        const receipt = head.receipts?.find(r => r.id === input.mutationId);
        if (receipt) {
            if (receipt.fingerprint !== fingerprint)
                throw recordError('OPERATION_CONFLICT', 'Browser operation ID reused with different content');
            return { revision: receipt.revision, keyRevision: receipt.keyRevision };
        }
        const actual = input.expectedKeyRevision !== undefined ? head.keyRevisions?.[input.key] ?? 0 : head.revision;
        const expected = input.expectedKeyRevision !== undefined ? input.expectedKeyRevision : input.expectedRevision;
        if (expected !== actual && (!Number.isSafeInteger(expected) || expected < 0 || expected > actual || previous.values[input.key] !== input.value))
            throw recordError('STATE_CONFLICT', 'Browser state changed in another client; reload to synchronize');
        let values;
        try {
            values = entries(input.key, JSON.parse(input.value));
            if (values.some(([id]) => typeof id !== 'string'))
                values = null;
        }
        catch {
            values = null;
        }
        const next = new Map(values ?? []);
        this.put(owner, 'legacy-values', input.key, input.value);
        for (const row of this.all(owner, input.key))
            if (!next.has(row.id))
                this.put(owner, input.key, row.id, null);
        for (const [id, value] of next) {
            this.assertOpenRecord(owner, input.key, id, value);
            const old = this.get(owner, input.key, id);
            if (!old || JSON.stringify(old.value) !== JSON.stringify(value))
                this.put(owner, input.key, id, value);
        }
        const keyRevision = (head.keyRevisions?.[input.key] ?? 0) + (expected === actual ? 1 : 0), revision = head.revision + (expected === actual ? 1 : 0);
        this.setLegacyHead(owner, { revision, keyRevisions: { ...head.keyRevisions, [input.key]: keyRevision }, lastMutation: input.mutationId,
            receipts: [...(head.receipts ?? []), { id: input.mutationId, fingerprint, revision, keyRevision }].slice(-256) });
        // Compatibility clients alone perform snapshot reconciliation. V2 changes use indexed joins.
        for (const row of this.all(owner, 'storage'))
            this.syncSession(owner, row.id);
        const retiring = [];
        if (input.key === 'storage')
            for (const [id, lease] of Object.entries(JSON.parse(previous.values.storage ?? '{}'))) {
                if (next.has(id))
                    continue;
                const key = JSON.stringify([owner, String(lease).replace(':', '-')]);
                this.retire(key, [id]);
                const record = this.session(key);
                if (record) {
                    this.saveSession({ ...record, lifecycle: 'closing', closing: true, runtime: { ...record.runtime, kind: 'stopping' } });
                    retiring.push(key);
                }
            }
        return { revision, keyRevision, retiring };
    }
    // Read-only diagnostics/legacy tests; never used by an entity mutation.
    get current() {
        const owners = this.db.prepare('SELECT owner FROM resource_legacy_heads').all().map(r => r.owner);
        return { schemaVersion: 1, pages: this.sessions(), retired: this.retiredKeys(), states: owners.map(owner => [owner, this.snapshot(owner)]) };
    }
}
/** Retain the exact v1 source; fence old writers before advertising v2 readiness.
 * A pre-fence crash cannot accept commands. A divergent legacy source is rejected. */
export async function fenceLegacyBrowserState(directory, bytes, digest) {
    if (bytes !== null) {
        const backup = join(directory, 'tabs-v1-' + digest + '.json');
        let file;
        try {
            file = await open(backup, 'wx', 0o600);
            await file.writeFile(bytes);
            await file.sync();
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        finally {
            await file?.close();
        }
        if (hash(await readFile(backup)) !== digest)
            throw new Error('Legacy browser backup verification failed');
    }
    const temporary = join(directory, 'records-cutover-' + randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {
        await file.writeFile(JSON.stringify({ schemaVersion: 2, database: 'resources.sqlite', legacyDigest: digest }));
        await file.sync();
    }
    finally {
        await file.close();
    }
    await rename(temporary, join(directory, 'tabs.json'));
    const parent = await open(directory, 'r');
    try {
        await parent.sync();
    }
    finally {
        await parent.close();
    }
}
