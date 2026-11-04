import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createSchemaValidator, verifyManagedDatabaseHistory } from '@opencraft/sqlite-node';
import { applyMigrations, prepareMigrations } from '../../packages/sqlite-node/src/migrations';
import { SERVER_DATA_CONTRACT, SERVER_MIGRATIONS, openServerDatabase } from '@opencraft/storage-node/server';
import { serverIdentityReadContracts, verifyServerIdentityRead } from '@opencraft/storage-node/server-identity-reader';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [v5, v6, v7] = serverIdentityReadContracts();
function fixture(version: 5 | 6) {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, prepareMigrations(version === 5 ? v5 : v6));
  db.exec("INSERT INTO opencraft_server_installation VALUES(1,'synthetic','synthetic',0)");
  return db;
}
function read(db: DatabaseSync) {
  db.exec('PRAGMA query_only=ON; BEGIN');
  try { verifyServerIdentityRead(db); } finally { db.exec('ROLLBACK; PRAGMA query_only=OFF'); }
}
for (const version of [5, 6] as const) test(`real ledger/schema ${version}: strict negative control and explicit reader`, () => {
  const db = fixture(version);
  try {
    for (const chain of [v5, v6]) {
      const verify = () => { verifyManagedDatabaseHistory(db, chain); createSchemaValidator(chain.map(m => m.sql).join(';\n'))(db); };
      if (chain.length === version) assert.doesNotThrow(verify);
      else assert.throws(verify);
    }
    assert.doesNotThrow(() => read(db));
  } finally { db.close(); }
});
const corruptions = {
  'wrong historical checksum': "UPDATE schema_migrations SET checksum='wrong' WHERE version=1",
  'wrong target checksum': "UPDATE schema_migrations SET checksum='wrong' WHERE version=6",
  'wrong name': "UPDATE schema_migrations SET name='wrong' WHERE version=5",
  'missing history': 'DELETE FROM schema_migrations WHERE version=3',
  'replaced history version': 'UPDATE schema_migrations SET version=7 WHERE version=6',
  'unknown future': "INSERT INTO schema_migrations VALUES(7,'future','unknown',0)",
  'wrong identity schema': 'ALTER TABLE actors ADD unexpected TEXT',
  'missing target index': 'DROP INDEX actor_conversation_creation_operation',
  'changed target constraint': 'DROP TABLE actor_conversation_creations; CREATE TABLE actor_conversation_creations(actor_id TEXT)',
  'extra object': 'CREATE TABLE unexpected(value TEXT)',
  'unfinished installation': 'DELETE FROM opencraft_server_installation',
  'unledgered': 'DROP TABLE schema_migrations',
};
for (const [name, sql] of Object.entries(corruptions)) test(`reader rejects ${name}`, () => {
  const db = fixture(6);
  try { db.exec(sql); assert.throws(() => read(db)); } finally { db.close(); }
});
test('reader rejects v4 and requires snapshot; writer promotes only to the exact declared v7', async () => {
  assert.equal(SERVER_MIGRATIONS.length, 7);
  assert.equal(SERVER_DATA_CONTRACT.migrationVersion, 7);
  assert.equal(SERVER_DATA_CONTRACT.hash, 'b5238d550289e111e1f94d0212f4273a34768ec26de6fc195ec3906258d539dd');
  assert.deepEqual(SERVER_MIGRATIONS,v7);
  assert.equal(createHash('sha256').update(v6[5]!.sql).digest('hex'), '03afd1d25a011359bcc3e5c6502219d0fcdb51fc23fbf941dd9e6cd5bdc31cc5');
  const db = new DatabaseSync(':memory:');
  try { applyMigrations(db, prepareMigrations(v5.slice(0, 4))); assert.throws(() => read(db)); assert.throws(() => verifyServerIdentityRead(db)); } finally { db.close(); }
  const root = await mkdtemp(join(tmpdir(), 'server-writer6-'));
  try {
    const server = await openServerDatabase(root);
    assert.equal(server.outcome.appliedVersion, 7);
    assert.ok(server.database.prepare("SELECT 1 FROM sqlite_master WHERE name='actor_conversation_creations'").get());
    assert.doesNotThrow(()=>read(server.database));
    await server.close();
    const future = new DatabaseSync(join(root, 'opencraft-server.sqlite'));
    future.prepare("INSERT INTO schema_migrations VALUES(8,'future','unknown',0)").run(); future.close();
    await assert.rejects(openServerDatabase(root), /newer database migration history/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for(const version of [5,6,7] as const) test(`known7 reader exact ${version} retains strict negative controls`,()=>{
 const db=new DatabaseSync(':memory:');const chains=[v5,v6,v7];
 try{applyMigrations(db,prepareMigrations(chains[version-5]!));db.exec("INSERT INTO opencraft_server_installation VALUES(1,'synthetic','synthetic',0)");
 for(const chain of chains){const verify=()=>{verifyManagedDatabaseHistory(db,chain);createSchemaValidator(chain.map(m=>m.sql).join(';\n'))(db);};if(chain.length===version)assert.doesNotThrow(verify);else assert.throws(verify);}
 assert.doesNotThrow(()=>read(db));}finally{db.close();}
});
for(const [name,sql] of Object.entries({checksum:"UPDATE schema_migrations SET checksum='bad' WHERE version=7",history:'DELETE FROM schema_migrations WHERE version=2',schema:'ALTER TABLE conversation_input_settings ADD extra TEXT',future8:"INSERT INTO schema_migrations VALUES(8,'future','bad',0)"}))test(`known7 rejects ${name}`,()=>{
 const db=new DatabaseSync(':memory:');try{applyMigrations(db,prepareMigrations(v7));db.exec("INSERT INTO opencraft_server_installation VALUES(1,'synthetic','synthetic',0)");db.exec(sql);assert.throws(()=>read(db));}finally{db.close();}
});
