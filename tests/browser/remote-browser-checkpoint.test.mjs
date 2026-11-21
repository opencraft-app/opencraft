import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BrowserStateStore } from '../../apps/headless-server/src/remote-browser/state-store.mjs';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-checkpoint-'));
  const store = new BrowserStateStore(directory); await store.open();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const key = JSON.stringify(['owner', 'browser-' + '2'.repeat(64)]);
  const page = { key, id: createHash('sha256').update(key).digest('hex'), ownerId: 'owner', lifecycle: 'open', runtime: { kind: 'absent' }, link: null,
    url: 'https://example.test/', zoom: 100, viewport: { width: 800, height: 600 } };
  await store.transact(draft => { draft.pages.push(page); });
  const service = Object.assign(Object.create(RemoteBrowserService.prototype), { store, pages: new Map([[key, structuredClone(page)]]) });
  const read = () => { const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT value FROM browser_pages WHERE key=?').get(key).value); } finally { db.close(); } };
  return { store, service, page, read };
}

test('unchanged recovery checkpoints issue no SQLite commit', async t => {
  const f = await fixture(t), original = f.store.call.bind(f.store); let commits = 0;
  f.store.call = (operation, ...args) => { if (operation === 'commit') commits++; return original(operation, ...args); };
  for (let index = 0; index < 20; index++) await f.service.persist();
  assert.equal(commits, 0);
  f.service.pages.get(f.page.key).zoom = 125; await f.service.persist();
  assert.equal(commits, 1); assert.equal(f.read().zoom, 125);
});

test('SQLite checkpoints follow queued lifecycle commits and cannot revive closed pages', async t => {
  const f = await fixture(t); f.service.pages.get(f.page.key).zoom = 125;
  const closed = f.store.transact(draft => { draft.pages[0].lifecycle = 'closed'; });
  const checkpoint = f.service.persist(); await Promise.all([closed, checkpoint]);
  const saved = f.read(); assert.equal(saved.lifecycle, 'closed'); assert.equal(saved.zoom, 100);
  await assert.rejects(f.store.transact(draft => { draft.pages[0].zoom = 999; throw Error('rejected draft'); }));
  await f.service.persist(); assert.deepEqual(f.read(), saved);
});
