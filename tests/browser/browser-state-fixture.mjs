import { DatabaseSync } from 'node:sqlite';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
/** Disposable fixtures only. Production accesses SQLite exclusively in Worker. */
export async function readBrowserState(directory) {
  const db = new DatabaseSync(join(directory, 'remote-browser/state.sqlite'), { readOnly: true });
  try {
    const state = { schemaVersion: 1 };
    for (const [field, table] of Object.entries({ pages: 'browser_pages', states: 'browser_metadata', closedTabs: 'browser_receipts', retiredResources: 'browser_retirements' })) {
      state[field] = db.prepare(`SELECT key,value FROM ${table} ORDER BY rowid`).all().map(row => field === 'states' ? [row.key, JSON.parse(row.value)] : JSON.parse(row.value));
    }
    state.retired = state.retiredResources.map(fact => fact.key); return state;
  } finally { db.close(); }
}
/** Convert a CLOSED disposable fixture to a genuine pre-migration installation. */
export async function makeLegacyBrowserState(directory, update) {
  const saved = await readBrowserState(directory); update(saved);
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite.identity']) await rm(join(directory, 'remote-browser', name), { force: true });
  await writeFile(join(directory, 'remote-browser/tabs.json'), JSON.stringify(saved), { mode: 0o600 });
  return saved;
}
