import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openManagedDatabase, } from '@opencraft/sqlite-node';
import type { DatabaseSync } from 'node:sqlite';
const SCHEMA = `
CREATE TABLE resource_records (
 owner TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), value TEXT, page_ref TEXT, lease_ref TEXT, scope_ref TEXT,
 PRIMARY KEY(owner,collection,id)
) STRICT;
CREATE INDEX resource_records_page ON resource_records(owner,collection,page_ref);
CREATE INDEX resource_records_lease ON resource_records(owner,collection,lease_ref);
CREATE INDEX resource_records_scope ON resource_records(owner,collection,scope_ref);
CREATE TABLE resource_mutations (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(owner,id)
) STRICT;
CREATE INDEX resource_mutations_owner_seq ON resource_mutations(owner,seq);
CREATE TABLE resource_imports (id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
CREATE TABLE resource_legacy_heads (owner TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;
export const WORKBENCH_RECORD_MIGRATIONS = [{ version: 1, name: 'workbench-resource-records', sql: SCHEMA }] as const;
export interface ResourceRecord {
    collection: string;
    id: string;
    revision: number;
    value: any | null;
}
export const recordError = (code: string, message: string) => Object.assign(new Error(message), { code });
/** The verified caller supplies owner. No request can select another principal.
 * Every entity and its retry receipt commit in the same SQLite transaction. */
export class WorkbenchRecordStore {
    readonly outcome;
    readonly db: DatabaseSync;
    tail: Promise<unknown> = Promise.resolve();
    private closed = false;
    constructor(path: string) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const opened = openManagedDatabase({ schemaId: "workbench-storage-node", path, migrations: WORKBENCH_RECORD_MIGRATIONS,
            legacyPolicy: 'reject-unknown' });
        this.db = opened.database;
        this.outcome = opened.outcome;
    }
    transaction<T>(reduce: () => T): T {
        if (this.closed)
            throw recordError('STORE_CLOSED', 'Resource store closed');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = reduce();
            if (result && typeof (result as any).then === 'function')
                throw new Error('Resource transaction reducer must be synchronous');
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            if (this.db.isTransaction)
                this.db.exec('ROLLBACK');
            throw error;
        }
    }
    queue<T>(reduce: () => T): Promise<T> {
        const operation = this.tail.then(() => this.transaction(reduce));
        this.tail = operation.catch(() => { });
        return operation;
    }
    get(owner: string, collection: string, id: string): ResourceRecord | null {
        const row = this.db.prepare('SELECT revision,value FROM resource_records WHERE owner=? AND collection=? AND id=?').get(owner, collection, id);
        return row ? { collection, id, revision: Number(row.revision), value: row.value === null ? null : JSON.parse(String(row.value)) } : null;
    }
    list(owner: string, collection: string, after = '', limit = 256): ResourceRecord[] {
        return this.db.prepare('SELECT id,revision,value FROM resource_records WHERE owner=? AND collection=? AND id>? AND value IS NOT NULL ORDER BY id LIMIT ?')
            .all(owner, collection, after, limit).map(row => ({ collection, id: String(row.id), revision: Number(row.revision), value: JSON.parse(String(row.value)) }));
    }
    all(owner: string, collection: string): ResourceRecord[] {
        return this.db.prepare('SELECT id,revision,value FROM resource_records WHERE owner=? AND collection=? AND value IS NOT NULL ORDER BY id')
            .all(owner, collection).map(row => ({ collection, id: String(row.id), revision: Number(row.revision), value: JSON.parse(String(row.value)) }));
    }
    find(owner: string, collection: string, field: 'page_ref' | 'lease_ref', value: string) {
        const row = this.db.prepare(`SELECT id FROM resource_records WHERE owner=? AND collection=? AND ${field}=? AND value IS NOT NULL LIMIT 1`).get(owner, collection, value);
        return row ? this.get(owner, collection, String(row.id)) : null;
    }
    put(owner: string, collection: string, id: string, value: any | null, revision?: number): ResourceRecord {
        const previous = revision === undefined ? this.get(owner, collection, id) : null;
        const next = revision ?? (previous?.revision ?? 0) + 1;
        const body = value === null ? null : JSON.stringify(value);
        const page = collection === 'tabs' && value ? value.pageId : null;
        const lease = collection === 'storage' && typeof value === 'string' ? value.replace(':', '-') : null;
        this.db.prepare(`INSERT INTO resource_records(owner,collection,id,revision,value,page_ref,lease_ref,scope_ref) VALUES(?,?,?,?,?,?,?,?)
   ON CONFLICT(owner,collection,id) DO UPDATE SET revision=excluded.revision,value=excluded.value,page_ref=excluded.page_ref,lease_ref=excluded.lease_ref,scope_ref=excluded.scope_ref`)
            .run(owner, collection, id, next, body, page, lease, (collection === 'pages' || collection === 'tabs') && value ? value.ownerId : null);
        return { collection, id, revision: next, value };
    }
    mutate(owner: string, input: {
        collection: string;
        id: string;
        value: any | null;
        expectedRevision: number;
        mutationId: string;
    }, validate?: (previous: any, next: any) => void) {
        const fingerprint = createHash('sha256').update(JSON.stringify([input.collection, input.id, input.value, input.expectedRevision])).digest('hex');
        const receipt = this.db.prepare('SELECT fingerprint,result FROM resource_mutations WHERE owner=? AND id=?').get(owner, input.mutationId);
        if (receipt) {
            if (receipt.fingerprint !== fingerprint)
                throw recordError('OPERATION_CONFLICT', 'Resource command ID reused');
            return JSON.parse(String(receipt.result)) as ResourceRecord;
        }
        const previous = this.get(owner, input.collection, input.id);
        if ((previous?.revision ?? 0) !== input.expectedRevision)
            throw recordError('STATE_CONFLICT', 'Resource changed in another client');
        validate?.(previous?.value ?? null, input.value);
        const result = this.put(owner, input.collection, input.id, input.value);
        this.db.prepare('INSERT INTO resource_mutations(owner,id,fingerprint,result) VALUES(?,?,?,?)').run(owner, input.mutationId, fingerprint, JSON.stringify(result));
        // Old commands remain fenced by the durable entity revision, including tombstones.
        this.db.prepare('DELETE FROM resource_mutations WHERE owner=? AND seq<(SELECT seq FROM resource_mutations WHERE owner=? ORDER BY seq DESC LIMIT 1 OFFSET 255)').run(owner, owner);
        return result;
    }
    imported(id: string) { return !!this.db.prepare('SELECT 1 FROM resource_imports WHERE id=?').get(id); }
    import(id: string, digest: string, apply: () => void) { if (this.imported(id))
        return; this.transaction(() => { if (this.imported(id))
        return; apply(); this.db.prepare('INSERT INTO resource_imports(id,digest) VALUES(?,?)').run(id, digest); }); }
    legacyHead(owner: string) { const row = this.db.prepare('SELECT value FROM resource_legacy_heads WHERE owner=?').get(owner); return row ? JSON.parse(String(row.value)) : { revision: 0, keyRevisions: {}, receipts: [] }; }
    setLegacyHead(owner: string, value: any) { this.db.prepare('INSERT INTO resource_legacy_heads(owner,value) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value').run(owner, JSON.stringify(value)); }
    close() { if (this.closed)
        return; this.closed = true; this.db.close(); }
}
