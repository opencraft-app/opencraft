import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { openManagedDatabase, resolveStoreMigrations, type StorageSchemaId } from '../../packages/sqlite-node/src/index';
import { readOwnerMigrations } from '../../scripts/storage-owner-source.mjs';
import { compileStore, freezeStore, readJournal, retainTableOptions, restoreIndexExpressions } from '../../scripts/storage-migration-tools.mjs';
import { ownerSchemaSignature } from './drizzle-owner-signature';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stores = JSON.parse(readFileSync(join(root, 'packages/storage-node/stores.json'), 'utf8')) as Array<{ id: StorageSchemaId; owner: string; index: number }>;

for (const store of stores) test(`${store.id}: adopted Drizzle baseline preserves the complete published schema and ledger`, async () => {
  const directory = join(root, 'packages/storage-node/src/stores', store.id);
  const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'));
  const legacy = await readOwnerMigrations(root, store);
  const opened = openManagedDatabase({ path: ':memory:', migrations: legacy });
  const db = opened.database;
  const expectedLedger = db.prepare('SELECT * FROM schema_migrations').all();
  const snapshot = JSON.parse(readFileSync(join(directory, 'migrations/meta/0000_snapshot.json'), 'utf8'));
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), snapshot);
  const declared = new DatabaseSync(':memory:');
  try {
    declared.exec(retainTableOptions(restoreIndexExpressions(statements.join('\n'), snapshot), baseline.tableOptions));
    assert.deepEqual(ownerSchemaSignature(declared), ownerSchemaSignature(db));
    const resolved = resolveStoreMigrations(store.id, legacy);
    assert.deepEqual(resolved.slice(0, legacy.length), legacy, 'the published prefix remains unchanged');
    assert.deepEqual(resolved.slice(legacy.length), compileStore(directory, { requirePublished: true }).migrations);
    assert.deepEqual(resolved.map(m => m.version), resolved.map((_, index) => index + 1));
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), expectedLedger);
    const tampered = legacy.map((migration: any, index: number) => index ? migration : { ...migration, sql: migration.sql + ' ' });
    assert.throws(() => resolveStoreMigrations(store.id, tampered), /Published migration prefix/);
    assert.throws(() => resolveStoreMigrations(store.id, [...legacy, { version: legacy.length + 1, name: 'handwritten', sql: 'SELECT 1' }]), /Published migration prefix/);
  } finally { declared.close(); db.close(); }
});

for (const id of ['thread-identity-database', 'opencraft-host-state-database'] as const) {
  for (const ledgered of [false, true]) test(`${id}: ${ledgered ? 'ledgered' : 'unledgered'} frozen baseline upgrades through generated migrations`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'oc-published-upgrade-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const legacy = await readOwnerMigrations(root, stores.find(store => store.id === id)!);
    const complete = resolveStoreMigrations(id, legacy);
    assert.ok(complete.length > legacy.length, 'fixture must exercise an actual appended migration');
    const path = join(directory, 'store.sqlite');
    let database = ledgered ? openManagedDatabase({ path, migrations: legacy }).database : new DatabaseSync(path);
    if (!ledgered) for (const migration of legacy) database.exec(migration.sql);
    database.prepare('INSERT INTO ioa_thread_creators VALUES (?,?)').run('thread', 'synthetic-user');
    const prefix = ledgered ? database.prepare('SELECT * FROM schema_migrations ORDER BY version').all() : [];
    database.close();
    const options = { path, schemaId: id, migrations: legacy };
    const upgraded = openManagedDatabase(options);
    try {
      assert.equal(upgraded.outcome.status, 'migrated');
      assert.equal(upgraded.outcome.appliedVersion, complete.length);
      assert.equal(upgraded.database.prepare('SELECT login_name FROM ioa_thread_creators').get()?.login_name, 'synthetic-user');
      if (ledgered) assert.deepEqual(upgraded.database.prepare('SELECT * FROM schema_migrations WHERE version<=? ORDER BY version').all(legacy.length), prefix);
      assert.deepEqual(upgraded.database.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map(row => [row.version, row.name]), complete.map(m => [m.version, m.name]));
      const backup = new DatabaseSync(upgraded.outcome.backupPath!, { readOnly: true });
      try {
        assert.equal(backup.prepare('SELECT login_name FROM ioa_thread_creators').get()?.login_name, 'synthetic-user');
        assert.equal(!!backup.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get(), ledgered);
      } finally { backup.close(); }
    } finally { upgraded.database.close(); }
    const again = openManagedDatabase(options);
    assert.equal(again.outcome.status, 'up-to-date');
    again.database.close();
    assert.throws(() => openManagedDatabase({ path, migrations: legacy }), (error: any) => error.kind === 'newer-schema');
  });
}

test('generator refuses broken order, snapshot ancestry, orphan files and changed baselines', () => {
  const rootFixture = mkdtempSync(join(tmpdir(), 'oc-storage-generator-'));
  const source = join(root, 'packages/storage-node/src/stores', stores[0].id);
  const fixture = () => { const directory = join(rootFixture, String(Math.random())); cpSync(source, directory, { recursive: true }); return directory; };
  try {
    let directory = fixture();
    let journal = readJournal(join(directory, 'migrations'));
    journal.entries[0].idx = 2;
    writeFileSync(join(directory, 'migrations/meta/_journal.json'), JSON.stringify(journal));
    assert.throws(() => compileStore(directory), /migration order/);
    directory = fixture();
    const snapshot = JSON.parse(readFileSync(join(directory, 'migrations/meta/0000_snapshot.json'), 'utf8'));
    snapshot.prevId = snapshot.id;
    writeFileSync(join(directory, 'migrations/meta/0000_snapshot.json'), JSON.stringify(snapshot));
    assert.throws(() => compileStore(directory), /snapshot chain/);
    directory = fixture(); writeFileSync(join(directory, 'migrations/orphan.sql'), 'SELECT 1');
    assert.throws(() => compileStore(directory), /Orphaned/);
    directory = fixture(); writeFileSync(join(directory, 'migrations/0000_legacy_baseline.sql'), 'SELECT 1');
    assert.throws(() => compileStore(directory), /baseline changed/);
  } finally { rmSync(rootFixture, { recursive: true, force: true }); }
});

test('a generated next migration upgrades a populated published store without replaying its prefix', async () => {
  const { sqliteTable, text, primaryKey } = await import('drizzle-orm/sqlite-core');
  const directory = mkdtempSync(join(tmpdir(), 'oc-drizzle-next-'));
  const source = join(root, 'packages/storage-node/src/stores/provider-retry');
  const fixture = join(directory, 'store'); cpSync(source, fixture, { recursive: true });
  const legacy = await readOwnerMigrations(root, stores.find(store => store.id === 'provider-retry')!);
  let db: DatabaseSync | undefined;
  try {
    const previous = JSON.parse(readFileSync(join(fixture, 'migrations/meta/0000_snapshot.json'), 'utf8'));
    const provider = sqliteTable('provider_retries', { thread_id: text('thread_id').notNull(), value: text('value').notNull(), note: text('note') }, table => {
      return [primaryKey({ columns: [table.thread_id] })];
    });
    const next = await generateSQLiteDrizzleJson({ provider }, previous.id);
    const sql = (await generateSQLiteMigration(previous, next)).join('\n');
    assert.match(sql, /ALTER TABLE/);
    writeFileSync(join(fixture, 'migrations/0001_retry_note.sql'), sql);
    writeFileSync(join(fixture, 'migrations/meta/0001_snapshot.json'), JSON.stringify(next));
    const journal = readJournal(join(source, 'migrations'));
    journal.entries.push({ idx: 1, version: '6', when: journal.entries[0].when + 1, tag: '0001_retry_note', breakpoints: true });
    writeFileSync(join(fixture, 'migrations/meta/_journal.json'), JSON.stringify(journal));
    const compiled = compileStore(fixture);
    assert.throws(() => compileStore(fixture, { requirePublished: true }), /Unfrozen migration/);
    freezeStore(fixture);
    assert.deepEqual(compileStore(fixture, { requirePublished: true }), compiled);
    // Once frozen, regeneration and freezing cannot bless an edited SQL file.
    writeFileSync(join(fixture, 'migrations/0001_retry_note.sql'), sql + '\n-- changed\n');
    assert.throws(() => compileStore(fixture), /Published migration changed/);
    assert.throws(() => freezeStore(fixture), /Published migration changed/);
    writeFileSync(join(fixture, 'migrations/0001_retry_note.sql'), sql);
    const path = join(directory, 'live.sqlite');
    db = openManagedDatabase({ path, migrations: legacy }).database;
    db.prepare('INSERT INTO provider_retries VALUES (?,?)').run('thread', '{"state":"waiting"}');
    const receipt = db.prepare('SELECT * FROM schema_migrations WHERE version=1').get(); db.close(); db = undefined;
    db = openManagedDatabase({ path, migrations: [...legacy, ...compiled.migrations] }).database;
    assert.deepEqual({ ...db.prepare('SELECT * FROM provider_retries').get() }, { thread_id: 'thread', value: '{"state":"waiting"}', note: null });
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version=1').get(), receipt);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 2);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('published generated migrations freeze SQL, snapshots, journal identity and compiled SQL', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'oc-publication-'));
  const source = join(root, 'packages/storage-node/src/stores/thread-identity-database');
  const fixture = () => { const directory = join(temporary, String(Math.random())); cpSync(source, directory, { recursive: true }); return directory; };
  try {
    for (const alter of [
      (directory: string) => { const sql = join(directory, 'migrations/0001_curvy_expediter.sql'); writeFileSync(sql, readFileSync(sql, 'utf8') + '\n-- edited\n'); },
      (directory: string) => { const snapshot = join(directory, 'migrations/meta/0001_snapshot.json'); writeFileSync(snapshot, readFileSync(snapshot, 'utf8') + '\n'); },
      (directory: string) => { const file = join(directory, 'migrations/meta/_journal.json'); const journal = readJournal(join(directory, 'migrations')); journal.entries[1].when++; writeFileSync(file, JSON.stringify(journal)); },
      (directory: string) => { const file = join(directory, 'migrations/meta/_journal.json'); const journal = readJournal(join(directory, 'migrations')); const previous = journal.entries[1].tag; journal.entries[1].tag = '0001_renamed'; renameSync(join(directory, 'migrations', previous + '.sql'), join(directory, 'migrations/0001_renamed.sql')); writeFileSync(file, JSON.stringify(journal)); },
      (directory: string) => { const file = join(directory, 'baseline.json'); const baseline = JSON.parse(readFileSync(file, 'utf8')); baseline.tableOptions.execution_goal_grants = { strict: false, withoutRowid: false }; writeFileSync(file, JSON.stringify(baseline)); },
      (directory: string) => { const file = join(directory, 'baseline.json'); const baseline = JSON.parse(readFileSync(file, 'utf8')); baseline.legacy.pop(); writeFileSync(file, JSON.stringify(baseline)); },
    ]) {
      const directory = fixture(); alter(directory);
      assert.throws(() => compileStore(directory), /Published migration changed/);
      assert.throws(() => freezeStore(directory), /Published migration changed/);
    }
    const directory = fixture();
    const journal = readJournal(join(directory, 'migrations'));
    const removed = journal.entries.pop()!;
    rmSync(join(directory, 'migrations', removed.tag + '.sql'));
    rmSync(join(directory, 'migrations/meta', String(removed.idx).padStart(4, '0') + '_snapshot.json'));
    writeFileSync(join(directory, 'migrations/meta/_journal.json'), JSON.stringify(journal));
    assert.throws(() => compileStore(directory), /Published migration changed/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
