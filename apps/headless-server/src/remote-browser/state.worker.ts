import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openManagedDatabase, sqliteTransaction } from '@opencraft/sqlite-node';
import { migrations } from './state-migrations.js';
import { validateReferences, emptyReferences } from './retirement-selection.mjs';
import { validateBrowserState } from './state-validation.mjs';
if (isMainThread) throw Error('Browser SQL must run in a Worker');
const directory = workerData.directory as string, path = join(directory, 'state.sqlite'), identityPath = join(directory, 'state.sqlite.identity');
let database: ReturnType<typeof openManagedDatabase>['database'] | undefined;
let terminalError: { message: string; fatal: true; code: string; retryable: false; outcome: string } | undefined;
const names = { pages: 'browser_pages', states: 'browser_metadata', closedTabs: 'browser_receipts' } as const;
function durableIdentity(value: string) {
  const temporary = identityPath + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, identityPath);
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function open() {
  if (database) throw Error('Browser storage already opened');
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : null;
  if ((identity !== null || existsSync(join(directory, 'tabs.imported.json'))) && !existsSync(path)) throw Error('Browser database missing after migration');
  const opened = openManagedDatabase({ path, schemaId: 'remote-browser', migrations, legacyPolicy: 'reject' });
  database = opened.database; database.exec('PRAGMA synchronous=FULL');
  const db = database;
  const meta = (key: string) => (db.prepare('SELECT value FROM browser_meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const sourcePath = join(directory, 'tabs.json'), archivePath = join(directory, 'tabs.imported.json');
  if (existsSync(sourcePath) && existsSync(archivePath)) throw Error('Retired browser JSON changed after migration');
  const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : null;
  const digest = source === null ? 'absent' : createHash('sha256').update(source).digest('hex');
  if (meta('import-complete') === undefined) {
    if (identity !== null || [...Object.values(names), 'browser_retirements', 'browser_presentations', 'browser_operations']
      .some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw Error('Browser import receipt missing');
    const saved = validateBrowserState(source === null ? { schemaVersion: 1, pages: [], retired: [], states: [] } : JSON.parse(source));
    sqliteTransaction(db, () => {
      for (const [field, table] of Object.entries(names)) {
        const insert = db.prepare(`INSERT INTO ${table} (key,value) VALUES (?,?)`);
        for (const row of saved[field] ?? []) insert.run(field === 'states' ? row[0] : row.key, JSON.stringify(field === 'states' ? row[1] : row));
      }
      const insert = db.prepare('INSERT INTO browser_retirements (key,owner,value) VALUES (?,?,?)');
      for (const fact of saved.retiredResources) { insert.run(fact.key, fact.ownerId, JSON.stringify(fact)); indexFact(fact); }
      const set = db.prepare('INSERT INTO browser_meta (key,value) VALUES (?,?)');
      set.run('legacy-digest', digest); set.run('installation', randomUUID()); set.run('import-complete', '1');
    });
  }
  if (meta('import-complete') !== '1' || !meta('installation') || identity !== null && identity !== meta('installation')) throw Error('Invalid browser installation identity');
  // A present retired source may never silently become a second writable truth.
  if (source !== null && meta('legacy-digest') !== digest) throw Error('Retired browser JSON changed after migration');
  if (source !== null) {
    if (existsSync(archivePath)) throw Error('Retired browser JSON changed after migration');
    renameSync(sourcePath, archivePath);
    const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  if (identity === null) durableIdentity(meta('installation')!);
  return { state: snapshot(), outcome: opened.outcome };
}
function snapshot() {
  const result: any = { schemaVersion: 1 };
  for (const [field, table] of Object.entries(names)) result[field] = database!.prepare(`SELECT key,value FROM ${table} ORDER BY rowid`).all()
    .map((row: any) => field === 'states' ? [row.key, JSON.parse(row.value)] : JSON.parse(row.value));
  result.retiredResources = []; result.retired = [];
  return validateBrowserState(result);
}
function commit({ changes, facts, presentationReceipts = [], operationReceipts = [] }: any) {
  const db = database!;
  sqliteTransaction(db, () => {
    for (const [field, table] of Object.entries(names)) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE key=?`), put = db.prepare(`INSERT INTO ${table} (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      for (const key of changes[field].remove) remove.run(key);
      for (const [key, value] of changes[field].put) put.run(key, value);
    }
    const presentationGet = db.prepare('SELECT owner,value FROM browser_presentations WHERE key=?');
    const presentationPut = db.prepare('INSERT INTO browser_presentations (key,owner,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const receipt of presentationReceipts) {
      if (!receipt || typeof receipt.ownerId !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.id)
        || !['pending', 'claimed', 'visible', 'failed', 'cancelled', 'expired'].includes(receipt.status)) throw Error('Invalid browser presentation receipt');
      const row = presentationGet.get(receipt.id) as { owner: string; value: string } | undefined;
      if (row) {
        const old = JSON.parse(row.value);
        if (row.owner !== receipt.ownerId || ['tabId', 'hostId', 'threadId', 'createdAt', 'expiresAt'].some(key => old[key] !== receipt[key])
          || old.clientId && old.clientId !== receipt.clientId || old.status === 'claimed' && receipt.status === 'pending'
          || ['visible', 'failed', 'cancelled', 'expired'].includes(old.status) && JSON.stringify(old) !== JSON.stringify(receipt))
          throw Error('Browser presentation receipt cannot be replayed or reassigned');
      }
      presentationPut.run(receipt.id, receipt.ownerId, JSON.stringify(receipt));
    }
    const operationGet = db.prepare('SELECT owner,value FROM browser_operations WHERE key=?');
    const operationPut = db.prepare('INSERT INTO browser_operations (key,owner,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const receipt of operationReceipts) {
      if (!receipt || typeof receipt.ownerId !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.id)
        || !['admitted', 'completed', 'failed', 'unknown'].includes(receipt.status)) throw Error('Invalid browser operation receipt');
      const row = operationGet.get(receipt.id) as { owner: string; value: string } | undefined;
      if (row) {
        const old = JSON.parse(row.value);
        if (row.owner !== receipt.ownerId || old.fingerprint !== receipt.fingerprint || old.method !== receipt.method
          || old.key !== receipt.key || old.status !== 'admitted' && JSON.stringify(old) !== JSON.stringify(receipt))
          throw Error('Browser operation receipt cannot be replayed or reassigned');
      }
      operationPut.run(receipt.id, receipt.ownerId, JSON.stringify(receipt));
    }
    const previous = db.prepare('SELECT value FROM browser_retirements WHERE key=?');
    const put = db.prepare('INSERT INTO browser_retirements (key,owner,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const fact of facts) {
      if (!fact || typeof fact.ownerId !== 'string' || typeof fact.lease !== 'string'
        || fact.key !== JSON.stringify([fact.ownerId, fact.lease]) || !Array.isArray(fact.pageIds) || !Array.isArray(fact.tabIds)
        || [...fact.pageIds, ...fact.tabIds].some(id => typeof id !== 'string')) throw Error('Invalid browser retirement identity');
      const row = previous.get(fact.key) as { value: string } | undefined;
      if (row) {
        const old = JSON.parse(row.value);
        if (old.pageIds.some((id: string) => !fact.pageIds.includes(id)) || old.tabIds.some((id: string) => !fact.tabIds.includes(id)))
          throw Error('Permanent retirement identities cannot be removed');
      }
      put.run(fact.key, fact.ownerId, JSON.stringify(fact)); indexFact(fact);
    }
  });
  return null;
}
function indexFact(fact: any) {
  const put = database!.prepare('INSERT OR IGNORE INTO browser_retirement_identities (owner,kind,id,key) VALUES (?,?,?,?)');
  for (const [kind, ids] of [['page', fact.pageIds], ['tab', fact.tabIds], ['lease', [fact.lease]]] as const)
    for (const id of ids) put.run(fact.ownerId, kind, id, fact.key);
}
function matches(owner: string, references: unknown) {
  if (typeof owner !== 'string') throw Error('Invalid browser owner');
  const refs = validateReferences(references), result = emptyReferences();
  const has = database!.prepare('SELECT 1 FROM browser_retirement_identities WHERE owner=? AND kind=? AND id=? LIMIT 1');
  for (const [field, kind] of [['pages', 'page'], ['tabs', 'tab'], ['leases', 'lease']] as const)
    result[field] = refs[field].filter((id: string) => has.get(owner, kind, id));
  return result;
}
function select({ keys, owners }: any) {
  const get = database!.prepare('SELECT value FROM browser_retirements WHERE key=?');
  return { keys, facts: keys.flatMap((key: string) => { const row = get.get(key) as { value: string } | undefined; return row ? [JSON.parse(row.value)] : []; }),
    owners: owners.map(([owner, refs]: any) => [owner, matches(owner, refs)]) };
}
function retirements({ owner, references }: any) {
  if (references !== undefined) return { references: matches(owner, references) };
  // Compatibility reads are explicit. New clients query only referenced IDs.
  return { facts: database!.prepare('SELECT value FROM browser_retirements WHERE owner=? ORDER BY rowid').all(owner).map((row: any) => JSON.parse(row.value)) };
}
parentPort!.on('message', ({ id, op, args }) => {
  if (terminalError && op !== 'close') { parentPort!.postMessage({ id, error: terminalError }); return; }
  try {
    let value: unknown;
    if (op === 'open') value = open();
    else if (op === 'has' && database) value = !!database.prepare('SELECT 1 FROM browser_retirements WHERE key=?').get(args.key);
    else if (op === 'select' && database) value = select(args);
    else if ((op === 'presentation-receipts' || op === 'operation-receipts') && database) {
      const table = op === 'presentation-receipts' ? 'browser_presentations' : 'browser_operations';
      const get = database.prepare(`SELECT value FROM ${table} WHERE key=? AND owner=?`);
      value = args.ids.flatMap((id: string) => { const row = get.get(id, args.owner) as { value: string } | undefined; return row ? [JSON.parse(row.value)] : []; });
    }
    else if (op === 'retirements' && database) value = retirements(args);
    else if (op === 'commit' && database) value = commit(args);
    else if (op === 'close') { database?.close(); database = undefined; value = null; }
    else throw Error('Unsupported browser storage operation');
    parentPort!.postMessage({ id, value });
  } catch (error) {
    terminalError ??= { message: (error as Error).message, fatal: true,
      code: 'BROWSER_UNAVAILABLE', retryable: false, outcome: 'unknown' };
    parentPort!.postMessage({ id, error: terminalError });
  }
});
