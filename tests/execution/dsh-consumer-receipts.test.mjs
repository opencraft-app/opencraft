import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {join} from 'node:path';
import {DshConsumerReceipts} from '../../scripts/server-deployment/dsh-consumer-receipts.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const root=await mkdtemp('/tmp/dsh-consumer-'), stores=[];
 t.after(async()=>{for(const store of stores)await store.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 return {root,open:async()=>{const store=await DshConsumerReceipts.open(root);stores.push(store);return store;}};
}
test('unknown consumer lease survives restart and requires exact committed response receipt',async t=>{
 const f=await fixture(t),old=await f.open();
 const finish=await old.begin({id:1,method:'turn/start',params:{input:'synthetic'}});
 const ready=await finish({id:1,result:{turnId:'one'}});
 assert.deepEqual(await finish({id:1,result:{turnId:'one'}}),ready);
 await assert.rejects(finish({id:1,result:{turnId:'different'}}),/changed/);
 assert.equal(old.observation().activeCount,1);
 await old.close();const next=await f.open();
 await assert.rejects(next.acknowledge({...ready,receipt:'cancelled'}),/Exact/);
 assert.equal(next.observation().activeCount,1);
 await next.acknowledge(ready);assert.equal(next.observation().activeCount,0);
 await next.begin({id:2,method:'turn/start'});
 await next.close();const uncertain=await f.open();assert.equal(uncertain.observation().activeCount,1);
 await assert.rejects(uncertain.acknowledge(ready),/Exact/);
});
test('imports a large legacy ledger exactly once, preserves unknowns and does incremental IO',async t=>{
 const f=await fixture(t),rows=Object.fromEntries(Array.from({length:21000},(_,i)=>['legacy-'+i,{request:'a'.repeat(64),state:i%10?'receipt':'unknown',...(i%10?{receipt:'b'.repeat(64)}:{}),retained:'original'}]));
 const source=JSON.stringify({schemaVersion:1,rows}),legacy=join(f.root,'consumer-receipts.json');
 await writeFile(legacy,source,{mode:0o600});
 const store=await f.open();assert.equal(store.observation().activeCount,21000);
 const initialWal=(await stat(join(f.root,'consumer-receipts.sqlite-wal'))).size;
 // A read-only inspection checks every imported record, including unknown data.
 const inspect=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData,{readOnly:true});parentPort.postMessage(db.prepare('SELECT id,value FROM dsh_consumer_receipts ORDER BY id').all());db.close();`,{eval:true,workerData:join(f.root,'consumer-receipts.sqlite')});
 const [imported]=await once(inspect,'message');await once(inspect,'exit');
 assert.deepEqual(Object.fromEntries(imported.map(row=>[row.id,JSON.parse(row.value)])),rows);
 await store.acknowledge({id:'legacy-1',receipt:rows['legacy-1'].receipt});
 for(let i=0;i<20;i++){const finish=await store.begin({id:i,method:'probe'});await store.acknowledge(await finish({id:i,result:{ok:true}}));}
 const wal=await stat(join(f.root,'consumer-receipts.sqlite-wal'));
 assert.ok(wal.size-initialWal<2*1024*1024,'60 mutations must not rewrite the 4 MB legacy table each time');
 assert.equal(hash(await readFile(legacy)),hash(source));
 await store.close();const next=await f.open();assert.equal(next.observation().activeCount,20999);
 await assert.rejects(next.acknowledge({id:'legacy-1',receipt:rows['legacy-1'].receipt}),/Exact/);
 await next.close();await writeFile(legacy,source+' ',{mode:0o600});await assert.rejects(f.open(),/source changed/);
});
test('SQLite contention blocks commit, not the network thread, and shutdown drains accepted operations',async t=>{
 const f=await fixture(t),store=await f.open();
 const lock=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');parentPort.on('message',()=>{db.exec('ROLLBACK');db.close();parentPort.close()});`,{eval:true,workerData:join(f.root,'consumer-receipts.sqlite')});
 await once(lock,'message');t.after(()=>lock.terminate());
 let committed=false;const begin=store.begin({id:1,method:'probe'}).then(value=>{committed=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,75));assert.equal(committed,false);assert.ok(store.observation().activeCount>0);
 // A timer completing while SQLite is locked proves the calling event loop is free.
 lock.postMessage('release');await once(lock,'exit');const finish=await begin;
 const proof=await finish({id:1,result:{}}),ack=store.acknowledge(proof),closing=store.close();await ack;await closing;
 const next=await f.open();assert.equal(next.observation().activeCount,0);
});
test('second writer and unavailable Worker fail closed without a synchronous fallback',async t=>{
 const f=await fixture(t),store=await f.open();await assert.rejects(f.open(),/Writer lock/);
 await store.close();await assert.rejects(store.begin({id:1}),/closing|exited/);
});
test('storage failure rejects pending/new work and reports unknown instead of using a JSON fallback',async t=>{
 const f=await fixture(t),store=await f.open();
 const corrupt=new Worker(`const{workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('DROP TABLE dsh_consumer_receipts');db.close();`,{eval:true,execArgv:[],workerData:join(f.root,'consumer-receipts.sqlite')});await once(corrupt,'exit');
 await assert.rejects(store.begin({id:1}),/no such table/);
 assert.deepEqual(store.observation(),{coverage:'unknown',activeCount:null});
 await assert.rejects(store.begin({id:2}),/no such table|exited/);
 await assert.rejects(readFile(join(f.root,'consumer-receipts.json')),/ENOENT/);
});

test('bundled receipt Worker runs without a source checkout or tsx loader', async t => {
 const {build} = await import('esbuild');
 const {mkdir} = await import('node:fs/promises');
 const {pathToFileURL} = await import('node:url');
 const root=await mkdtemp('/tmp/dsh-receipt-bundle-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime'),data=join(root,'data');
 await mkdir(runtime);await mkdir(data);
 await build({entryPoints:['scripts/server-deployment/dsh-consumer-receipts.mjs'],outfile:join(runtime,'receipts.mjs'),bundle:true,platform:'node',format:'esm'});
 await build({entryPoints:['scripts/server-deployment/dsh-consumer-receipts.worker.ts'],outfile:join(runtime,'dsh-consumer-receipts-worker.mjs'),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
 const {DshConsumerReceipts:Bundled}=await import(pathToFileURL(join(runtime,'receipts.mjs')).href);
 const store=await Bundled.open(data);t.after(()=>store.close());
 const finish=await store.begin({id:1,method:'synthetic'});
 await store.acknowledge(await finish({id:1,result:{ok:true}}));
 assert.equal(store.observation().activeCount,0);
});
