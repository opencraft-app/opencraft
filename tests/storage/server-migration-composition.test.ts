import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerMigrationComposition,createServerMigrationRegistry,DEFAULT_SERVER_MIGRATION_COMPOSITION} from '../../packages/storage-node/src/server/migration-composition';
import {SERVER_MIGRATION_CONTRACT_HASH,SERVER_MIGRATIONS} from '../../packages/storage-node/src/server/migrations.generated';
const input=()=>({canonical:[{version:1,name:'fixture',sql:'CREATE TABLE fixture(id INTEGER PRIMARY KEY)'}],alternates:[],productVersion:'fixture'});
test('default family preserves the exact published migration contract',()=>{
 assert.equal(DEFAULT_SERVER_MIGRATION_COMPOSITION.contract.hash,SERVER_MIGRATION_CONTRACT_HASH);
 assert.equal(DEFAULT_SERVER_MIGRATION_COMPOSITION.contract.migrationVersion,SERVER_MIGRATIONS.length);
 assert.deepEqual(DEFAULT_SERVER_MIGRATION_COMPOSITION.canonical,SERVER_MIGRATIONS);
});
test('composition snapshots and freezes SQL, metadata and alternate histories',()=>{
 const value=input(),composition=createServerMigrationComposition(value);value.canonical[0]!.sql='DROP TABLE fixture';
 assert.match(composition.canonical[0]!.sql,/CREATE TABLE/);assert.ok(Object.isFrozen(composition));assert.ok(Object.isFrozen(composition.canonical));assert.ok(Object.isFrozen(composition.canonical[0]));assert.ok(Object.isFrozen(composition.contract));
});
test('supplied contract fingerprints cannot mislabel a different SQL family',()=>{
 assert.throws(()=>createServerMigrationComposition({...input(),expectedHash:'0'.repeat(64)}),/hash mismatch/);
 const a=createServerMigrationComposition(input()),b=createServerMigrationComposition({...input(),alternates:[{id:'legacy',migrations:input().canonical}]});assert.notEqual(a.contract.hash,b.contract.hash);
});
test('invalid and discontinuous migrations fail before any database access',()=>{
 for(const canonical of [[],[{version:2,name:'gap',sql:'SELECT 1'}],[{version:1,name:'empty',sql:''}]])assert.throws(()=>createServerMigrationComposition({...input(),canonical}));
 assert.throws(()=>createServerMigrationComposition({...input(),alternates:[{id:'x',migrations:input().canonical},{id:'x',migrations:input().canonical}]}),/alternate/);
});
test('registry installation selects SQL and its data contract together',()=>{
 const fallback=createServerMigrationComposition(input()),selected=createServerMigrationComposition({...input(),productVersion:'installed'}),registry=createServerMigrationRegistry(fallback);
 assert.equal(registry.installed(),undefined);registry.install(selected);const effective=registry.current();assert.equal(effective.contract.productVersion,'installed');assert.equal(effective.contract.hash,selected.contract.hash);assert.equal(registry.installed(),effective);
});
test('failed registration cannot poison a later valid installation',()=>{
 const selected=createServerMigrationComposition(input()),registry=createServerMigrationRegistry(selected);
 assert.throws(()=>registry.install(undefined as any));
 assert.throws(()=>registry.install({...selected,contract:{...selected.contract,hash:'0'.repeat(64)}}));
 assert.equal(registry.installed(),undefined);registry.install(selected);assert.equal(registry.current().contract.hash,selected.contract.hash);
});
test('registry rejects replacement and late installation but permits the same owner',()=>{
 const a=createServerMigrationComposition(input()),b=createServerMigrationComposition(input()),registry=createServerMigrationRegistry(a);registry.install(a);assert.throws(()=>registry.install(b),/already installed/);registry.current();registry.install(a);assert.throws(()=>registry.install(b),/already in use/);
 const unopened=createServerMigrationRegistry(a);unopened.current();assert.throws(()=>unopened.install(a),/already in use/);
});
