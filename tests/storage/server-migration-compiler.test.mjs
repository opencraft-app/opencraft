import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const source=fileURLToPath(new URL('../../',import.meta.url));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'server-compiler-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const server=join(root,'packages/storage-node/src/server');mkdirSync(server,{recursive:true});mkdirSync(join(root,'scripts/storage'),{recursive:true});
 cpSync(join(source,'packages/storage-node/src/server/migrations'),join(server,'migrations'),{recursive:true});
 for(const name of ['migration-lineages.json','migrations.generated.ts'])copyFileSync(join(source,'packages/storage-node/src/server',name),join(server,name));
 for(const name of ['compile-storage-migrations.mjs','storage-migration-tools.mjs'])copyFileSync(join(source,'scripts/storage',name),join(root,'scripts/storage',name));
 writeFileSync(join(root,'package.json'),JSON.stringify({version:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version}));
 const run=(...args)=>spawnSync(process.execPath,['scripts/storage/compile-storage-migrations.mjs',...args],{cwd:root,encoding:'utf8'});
 return{root,server,run};
}
test('Server compiler frozen family reproduces reviewed output without edits',t=>{
 const f=fixture(t),before=readFileSync(join(f.server,'migrations.generated.ts'),'utf8'),result=f.run('--check');assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(f.server,'migrations.generated.ts'),'utf8'),before);
});
for(const damage of ['sql','snapshot','unknown-alternate','frozen-name','alternate-name'])test(`Server compiler rejects changed ${damage} before replacing generated output`,t=>{
 const f=fixture(t),output=join(f.server,'migrations.generated.ts'),before=readFileSync(output,'utf8');
 const journal=JSON.parse(readFileSync(join(f.server,'migrations/meta/_journal.json'),'utf8')),last=journal.entries.at(-1);
 if(damage==='sql'){const file=join(f.server,'migrations',last.tag+'.sql');writeFileSync(file,readFileSync(file,'utf8')+'\n-- changed frozen bytes\n');}
 else if(damage==='snapshot'){const file=join(f.server,'migrations/meta',String(last.idx).padStart(4,'0')+'_snapshot.json'),value=JSON.parse(readFileSync(file,'utf8'));value.id=randomUUID();writeFileSync(file,JSON.stringify(value));}
 else {const file=join(f.server,'migration-lineages.json'),value=JSON.parse(readFileSync(file,'utf8'));if(damage==='unknown-alternate')value.alternates[0].published[2].checksum='0'.repeat(64);else if(damage==='alternate-name')value.alternates[0].published[2].name='changed';else value.canonicalPublished[2].name='changed';writeFileSync(file,JSON.stringify(value));}
 const result=f.run('--check');assert.notEqual(result.status,0);assert.match(result.stderr,/Published Server|Unknown or ambiguous/);assert.equal(readFileSync(output,'utf8'),before);
});
test('Server compiler requires explicit freeze for a new append and preserves every published identity',t=>{
 const f=fixture(t),manifestFile=join(f.server,'migration-lineages.json'),before=JSON.parse(readFileSync(manifestFile,'utf8')).canonicalPublished;
 const journalFile=join(f.server,'migrations/meta/_journal.json'),journal=JSON.parse(readFileSync(journalFile,'utf8')),previous=journal.entries.at(-1),index=journal.entries.length,tag=String(index).padStart(4,'0')+'_fixture_append';
 const snapshot=JSON.parse(readFileSync(join(f.server,'migrations/meta',String(previous.idx).padStart(4,'0')+'_snapshot.json'),'utf8'));snapshot.prevId=snapshot.id;snapshot.id=randomUUID();
 journal.entries.push({...previous,idx:index,tag,when:previous.when+1});writeFileSync(journalFile,JSON.stringify(journal));writeFileSync(join(f.server,'migrations',tag+'.sql'),'SELECT 1;');writeFileSync(join(f.server,'migrations/meta',String(index).padStart(4,'0')+'_snapshot.json'),JSON.stringify(snapshot));
 const rejected=f.run('--check');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Unpublished Server/);
 const frozen=f.run('--freeze');assert.equal(frozen.status,0,frozen.stderr);assert.deepEqual(JSON.parse(readFileSync(manifestFile,'utf8')).canonicalPublished.slice(0,before.length),before);
 const checked=f.run('--check');assert.equal(checked.status,0,checked.stderr);
});

test('imported Server compiler checks an explicit owner without touching the default tree',t=>{
 const f=fixture(t),privateRoot=join(f.root,'private-server');cpSync(f.server,privateRoot,{recursive:true});
 const journal=JSON.parse(readFileSync(join(f.server,'migrations/meta/_journal.json'),'utf8'));writeFileSync(join(f.server,'migrations',journal.entries[0].tag+'.sql'),'SELECT 0; -- intentionally invalid default owner');
 const output=readFileSync(join(privateRoot,'migrations.generated.ts'),'utf8');
 const code=`import {compileServerMigrations} from './scripts/storage/compile-storage-migrations.mjs';compileServerMigrations({root:${JSON.stringify(privateRoot)},check:true});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:f.root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(privateRoot,'migrations.generated.ts'),'utf8'),output);
 assert.match(readFileSync(join(f.server,'migrations',journal.entries[0].tag+'.sql'),'utf8'),/intentionally invalid/);
});
