import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openServerDatabase,SERVER_MIGRATIONS} from '@opencraft/storage-node/server';
import {serverIdentityReadContracts,verifyServerIdentityRead} from '@opencraft/storage-node/server-identity-reader';
import {applyMigrations,prepareMigrations} from '../../packages/sqlite-node/src/migrations';
import {createSchemaValidator,verifyManagedDatabaseHistory} from '@opencraft/sqlite-node';
const chains=serverIdentityReadContracts();
function read(db:DatabaseSync){db.exec('BEGIN');try{verifyServerIdentityRead(db);}finally{db.exec('ROLLBACK');}}
for(const version of [5,6,7,8,9])test(`known9 reader accepts complete exact ${version}, older strict owners reject9`,()=>{
 const db=new DatabaseSync(':memory:');try{
  const selected=chains.find(c=>c.length===version)!;applyMigrations(db,prepareMigrations(selected));db.exec("INSERT INTO opencraft_server_installation VALUES(1,'fixture','fixture',0)");assert.doesNotThrow(()=>read(db));
  for(const chain of chains){const verify=()=>{verifyManagedDatabaseHistory(db,chain);createSchemaValidator(chain.map(m=>m.sql).join(';\n'))(db);};if(chain.length===version)assert.doesNotThrow(verify);else assert.throws(verify);}
 }finally{db.close();}
});
test('reader-only writer remains7, original8 is byte exact and attachment9 adds only three tables',()=>{
 assert.equal(SERVER_MIGRATIONS.length,7);
 assert.equal(createHash('sha256').update(JSON.stringify(chains.find(c=>c.length===8)!)).digest('hex'),'97c64637c06de25f823e48159ea2223932324c708b363443d5ea1ad767af3fd3');
 const sql=chains.find(c=>c.length===9)![8].sql;assert.equal((sql.match(/CREATE TABLE/gu)||[]).length,3);assert.doesNotMatch(sql,/ALTER TABLE|DROP|service_tier/iu);
});
for(const [name,sql] of Object.entries({checksum:"UPDATE schema_migrations SET checksum='bad' WHERE version=9",history:'DELETE FROM schema_migrations WHERE version=2',schema:'ALTER TABLE conversation_attachment_uploads ADD extra TEXT',future:"INSERT INTO schema_migrations VALUES(10,'future','bad',0)",extra:'CREATE TABLE unexpected(value TEXT)'}))test(`known9 rejects ${name}`,()=>{
 const db=new DatabaseSync(':memory:');try{applyMigrations(db,prepareMigrations(chains.find(c=>c.length===9)!));db.exec("INSERT INTO opencraft_server_installation VALUES(1,'fixture','fixture',0)");db.exec(sql);assert.throws(()=>read(db));}finally{db.close();}
});
