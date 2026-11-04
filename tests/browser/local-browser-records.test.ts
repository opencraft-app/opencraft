import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteClientResources } from '../../packages/document-storage/src/client-resources-sqlite';
import { openIndexedDbClientResources } from '../../apps/workbench-web/src/runtime/indexeddb-client-resources';
import { createLocalBrowserStorage } from '../../apps/workbench-web/src/browser/local-browser-records';
import { browserMetadataKeys } from '@opencraft/workbench-runtime/browser-metadata-identity';
Object.assign(globalThis, { IDBKeyRange });
for (const kind of ['sqlite', 'indexeddb'] as const)
    test(`${kind}: browser rows migrate once, flush independently and retain deletion on reopen`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'browser-local-')), factory = new IDBFactory();
        const open = () => kind === 'sqlite' ? Promise.resolve(new SqliteClientResources(join(root, 'resources.sqlite'))) : openIndexedDbClientResources('browser', factory);
        const legacy = async () => ({ [browserMetadataKeys.bindings]: JSON.stringify([{ scopeId: 'draft', hostId: 'host', threadId: null }]) });
        let storage = await createLocalBrowserStorage({ backend: await open(), namespace: 'test', legacy });
        try {
            assert.equal(storage.records!.rows('bindings').length, 1);
            storage.records!.put('bindings', 'draft', { scopeId: 'draft', hostId: 'host', threadId: 'thread' });
            await storage.records!.flush();
            storage.records!.remove('bindings', 'draft');
            await storage.records!.flush();
            await storage.dispose!();
            storage = await createLocalBrowserStorage({ backend: await open(), namespace: 'test', legacy });
            assert.equal(storage.records!.rows('bindings').length, 0);
            assert.equal(storage.records!.get('bindings', 'draft')!.revision, 3);
            storage.records!.put('bindings', 'other', { scopeId: 'other', hostId: 'host', threadId: null });
            await storage.records!.flush();
            assert.throws(() => storage.setItem(browserMetadataKeys.bindings, '[]'), /read-only/);
        }
        finally {
            await storage.dispose!();
            rmSync(root, { recursive: true, force: true });
        }
    });
