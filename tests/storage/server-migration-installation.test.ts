import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {openManagedDatabase} from '@opencraft/sqlite-node';
import {openServerDatabase,installServerMigrationComposition,createServerMigrationComposition,SERVER_DATA_CONTRACT} from '../../packages/storage-node/src/server/index';
import {DEFAULT_SERVER_MIGRATION_COMPOSITION} from '../../packages/storage-node/src/server/migration-composition';
const base=DEFAULT_SERVER_MIGRATION_COMPOSITION;
const extend=(chain:typeof base.canonical)=>[...chain,{version:chain.length+1,name:'fixture_installation_owner',sql:'CREATE TABLE fixture_installation_owner(id INTEGER PRIMARY KEY, value TEXT) STRICT;'}];
const selected=createServerMigrationComposition({canonical:extend(base.canonical),alternates:base.alternates.map(a=>({id:a.id,migrations:extend(a.migrations)})),productVersion:base.contract.productVersion});
installServerMigrationComposition(selected);
test('fresh installed owner exposes the selected contract, persists it and reopens without rewriting history',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'server-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));let owner=await openServerDatabase(dir);
 assert.notEqual(owner.contract.hash,SERVER_DATA_CONTRACT.hash);assert.deepEqual(owner.contract,selected.contract);assert.equal(owner.outcome.appliedVersion,selected.canonical.length);
 assert.equal(owner.database.prepare('SELECT contract_hash FROM opencraft_server_installation').get()!.contract_hash,selected.contract.hash);
 owner.database.prepare('INSERT INTO fixture_installation_owner VALUES(1,?)').run('preserved');const ledger=owner.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();await owner.close();
 owner=await openServerDatabase(dir);assert.equal(owner.database.prepare('SELECT value FROM fixture_installation_owner').get()!.value,'preserved');assert.deepEqual(owner.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),ledger);await owner.close();
});
for(const [index,chain] of [base.canonical,...base.alternates.map(a=>a.migrations)].entries())for(let count=1;count<=chain.length;count++)test(`installed owner preserves exact published lineage ${index} prefix ${count}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'server-prefix-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'opencraft-server.sqlite');const seeded=openManagedDatabase({path,migrations:chain.slice(0,count),legacyPolicy:'reject'});const ledger=seeded.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();seeded.database.close();
 const owner=await openServerDatabase(dir);try{assert.deepEqual(owner.database.prepare('SELECT * FROM schema_migrations ORDER BY version LIMIT ?').all(count),ledger);assert.deepEqual(owner.contract,selected.contract);assert.ok(owner.database.prepare("SELECT name FROM sqlite_master WHERE name='fixture_installation_owner'").get());}finally{await owner.close();}
});
test('unknown checksum is rejected without adopting or overwriting the ledger',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'server-reject-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'opencraft-server.sqlite'),seeded=openManagedDatabase({path,migrations:base.canonical,legacyPolicy:'reject'});seeded.database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('fixture-corruption');const before=seeded.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();seeded.database.close();await assert.rejects(openServerDatabase(dir),{kind:'history-mismatch'});const db=new DatabaseSync(path,{readOnly:true});try{assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),before);}finally{db.close();}
});

test('a process without the installed composition cannot adopt its extra ledger version',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'server-missing-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));const owner=await openServerDatabase(dir);const before=owner.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();await owner.close();
 const module=new URL('../../packages/storage-node/src/server/index.ts',import.meta.url).href;
 const code=`import {openServerDatabase} from ${JSON.stringify(module)};let rejected=false;try{const owner=await openServerDatabase(process.argv[1]);await owner.close();}catch(error){if(error.kind!=='newer-schema')throw error;rejected=true;}if(!rejected)throw Error('Missing installation was accepted');`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code,dir],{encoding:'utf8'});assert.equal(child.status,0,child.stdout+child.stderr);
 const db=new DatabaseSync(join(dir,'opencraft-server.sqlite'),{readOnly:true});try{assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),before);}finally{db.close();}
});
