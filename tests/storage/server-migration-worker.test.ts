import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sql='CREATE TABLE fixture_worker_installation(id INTEGER PRIMARY KEY, value TEXT) STRICT;';
const fixture=`import {ServerSpacesRuntime} from ${JSON.stringify(join(root,'packages/access-control/src/server-spaces-runtime.ts'))};
import {createServerMigrationComposition,installServerMigrationComposition} from ${JSON.stringify(join(root,'packages/storage-node/src/server/index.ts'))};
import {DEFAULT_SERVER_MIGRATION_COMPOSITION as base} from ${JSON.stringify(join(root,'packages/storage-node/src/server/migration-composition.ts'))};
const extend=chain=>[...chain,{version:chain.length+1,name:'fixture_worker_installation',sql:${JSON.stringify(sql)}}];
export const selected=createServerMigrationComposition({canonical:extend(base.canonical),alternates:base.alternates.map(a=>({id:a.id,migrations:extend(a.migrations)})),productVersion:base.contract.productVersion});
export async function run(directory,installed,borrowed=false){
 if(installed)installServerMigrationComposition(selected);
 const runtime=new ServerSpacesRuntime({...borrowed?{path:directory+'/opencraft-server.sqlite'}:{directory},serverMigrationComposition:{unexpected:'request-selected'}});
 try{await runtime.ready;return {outcome:runtime.outcome,contract:installed?selected.contract:base.contract};}finally{await runtime.close();}
}`;
function read(directory:string) {
 const db=new DatabaseSync(join(directory,'opencraft-server.sqlite'),{readOnly:true});
 try{return {ledger:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),contract:db.prepare('SELECT contract_hash FROM opencraft_server_installation').get()!.contract_hash,fixture:!!db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_worker_installation'").get()};}finally{db.close();}
}
for(const packaged of [false,true])test(`${packaged?'minified bundled':'source'} Worker inherits only the installed migration family and refuses missing configuration`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'server-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,'entry.mjs');await writeFile(source,fixture);let entry=source;
 if(packaged){
  entry=join(dir,'bundle.mjs');const common={bundle:true,platform:'node' as const,format:'esm' as const,target:'node26',minify:true,logLevel:'silent' as const,banner:{js:"import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);"}};
  await build({...common,entryPoints:[source],outfile:entry});await build({...common,entryPoints:[join(root,'packages/access-control/src/server-spaces.worker.ts')],outfile:join(dir,'server-spaces-worker.mjs')});
 }
 const load=(id:string)=>import(pathToFileURL(entry).href+'?case='+id);
 const ordinary=await load('ordinary'),defaultDir=join(dir,'ordinary');const baseline=await ordinary.run(defaultDir,false);assert.equal(read(defaultDir).fixture,false);assert.equal(read(defaultDir).contract,baseline.contract.hash);
 const installed=await load('installed'),installedDir=join(dir,'installed');const opened=await installed.run(installedDir,true);assert.equal(opened.outcome.appliedVersion,installed.selected.canonical.length);const before=read(installedDir);assert.equal(before.fixture,true);assert.equal(before.contract,installed.selected.contract.hash);
 await installed.run(installedDir,true);assert.deepEqual(read(installedDir),before);
 if(packaged){
  const absent=await load('missing');await assert.rejects(absent.run(installedDir,false),error=>{assert.match(String((error as Error).cause),/Unsupported newer Server history/);return true;});
 }else{
  // Source modules share a process registry. A real missing installation needs a
  // fresh process, not a cache-busted fixture that still imports the same owner.
  const code=`import {run} from ${JSON.stringify(pathToFileURL(source).href)};let refused=false;try{await run(${JSON.stringify(installedDir)},false);}catch(error){if(!String(error.cause).includes('Unsupported newer Server history'))throw error;refused=true;}if(!refused)throw Error('Missing installation accepted');`;
  const runner=join(dir,'without-install.mjs');await writeFile(runner,code);
  const child=spawnSync(process.execPath,['--import','tsx',runner],{encoding:'utf8'});assert.equal(child.status,0,child.stdout+child.stderr);
 }
 assert.deepEqual(read(installedDir),before);
 assert.equal((await installed.run(installedDir,true,true)).outcome,null);assert.deepEqual(read(installedDir),before);
 if(packaged){
  const invalidDir=join(dir,'invalid'),worker=new Worker(pathToFileURL(join(dir,'server-spaces-worker.mjs')),{workerData:{directory:invalidDir,serverMigrationComposition:{...installed.selected,contract:{...installed.selected.contract,hash:'0'.repeat(64)}}}});t.after(()=>worker.terminate());
  const error=await new Promise<Error>(resolve=>worker.once('error',resolve));assert.match(error.message,/hash mismatch/);await worker.terminate();assert.equal(existsSync(invalidDir),false);
 }
});
