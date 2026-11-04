import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer, get } from 'node:http';
import { openServerDatabase } from '../../packages/storage-node/src/server/index';
import { ThreadOrchestrationLedger, type ThreadRelation } from '../../packages/access-control/src/orchestration-ledger';
import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store';
import { ThreadOrchestrationBroker } from '../../packages/access-control/src/thread-orchestration-broker';
import type { Collaboration } from '../../packages/access-control/src/collaboration';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const snapshot={threadId:'child',rootTurnId:'root',turnId:'turn',state:'active' as const};
function relation(threadId:string,parentThreadId:string|null=null):ThreadRelation{return {threadId,serverId:'fixture-server',driverKind:'codex',ownerActorId:'fixture-actor',parentThreadId,lifecycleOwnerThreadId:parentThreadId,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'starting',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null};}
async function fixture(t:test.TestContext,parent=false){
 const dir=await mkdtemp(join(tmpdir(),'orchestration-worker-'));const owner=await openServerDatabase(dir);
 const ledger=new ThreadOrchestrationLedger(owner.database);
 if(parent)ledger.createThread(relation('parent'));ledger.createThread(relation('child',parent?'parent':null));
 const worker=new OrchestrationRuntimeWorker(join(dir,'opencraft-server.sqlite'));await worker.start();
 t.after(async()=>{await worker.close().catch(()=>{});await owner.close();await rm(dir,{recursive:true,force:true});});
 return {dir,owner,ledger,worker};
}
async function forbidMainSql(work:()=>Promise<void>){
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 const probe=new DatabaseSync(':memory:');const statement=probe.prepare('SELECT 1');const proto=Object.getPrototypeOf(statement);
 const methods=new Map(['get','all','run','iterate'].map(k=>[k,proto[k]]));probe.close();
 const forbidden=()=>{throw new Error('SQLite on network main thread');};
 DatabaseSync.prototype.prepare=forbidden;DatabaseSync.prototype.exec=forbidden;
 for(const key of methods.keys())proto[key]=forbidden;
 try{await work();}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;for(const [k,v] of methods)proto[k]=v;}
}
test('repeated observations and broker idle sweeps execute zero main-thread SQL and do not dirty the WAL',async t=>{
 const {owner,worker,ledger}=await fixture(t);await worker.observe(snapshot,1000);
 const stamp=owner.database.prepare('PRAGMA data_version').get()!.data_version;
 const broken=()=>{throw Error('Synchronous collaboration storage used by sweep');};
 const collaboration={orchestration:new Proxy({},{get:broken}),pendingOrchestrationAcks:broken} as unknown as Collaboration;
 const broker=new ThreadOrchestrationBroker(collaboration,{snapshot:async()=>snapshot} as any,()=>2000,worker);
 await forbidMainSql(async()=>{for(let i=0;i<100;i++)await worker.observe(snapshot,2000+i);for(let i=0;i<10;i++)await broker.reconcile();await worker.pendingAcks();await broker.close();});
 assert.equal(owner.database.prepare('PRAGMA data_version').get()!.data_version,stamp,'same state never commits new bytes');
 assert.equal(ledger.runtimeSnapshot('child')?.state,'active');
 assert.equal(owner.database.prepare('SELECT updated_at_ms FROM opencraft_orchestration_runtime_views WHERE thread_id=?').get('child')!.updated_at_ms,1000);
});
test('a real writer lock stalls only the storage worker while HTTP keeps responding',async t=>{
 const {owner,worker}=await fixture(t);const server=createServer((_req,res)=>res.end('ok'));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 owner.database.exec('BEGIN IMMEDIATE');let settled=false;
 const observation=worker.observe(snapshot,1000).finally(()=>{settled=true;});
 try{
  for(let i=0;i<12;i++){
   await new Promise<void>((resolve,reject)=>{get(`http://127.0.0.1:${(server.address() as any).port}`,res=>{assert.equal(res.statusCode,200);res.resume();res.once('end',resolve);}).once('error',reject);});
   await pause(10);
  }
  assert.equal(settled,false,'observation cannot commit through the held lock');
 }finally{owner.database.exec('ROLLBACK');}
 await observation;
});
test('runtime and parent notification roll back together; the same observation can retry',async t=>{
 const {owner,ledger,worker}=await fixture(t,true);await worker.observe(snapshot,1000);
 owner.database.exec("CREATE TRIGGER fixture_reject_notice BEFORE INSERT ON opencraft_parent_notification_batches BEGIN SELECT RAISE(ABORT,'fixture reject'); END");
 const completed={...snapshot,state:'completed' as const};await assert.rejects(worker.observe(completed,2000),/fixture reject/);
 assert.equal(ledger.runtimeSnapshot('child')?.state,'active');assert.equal(ledger.relation('child')?.runtimeStatus,'active');assert.equal(ledger.dueNotifications().length,0);
 owner.database.exec('DROP TRIGGER fixture_reject_notice');await worker.observe(completed,3000);
 assert.equal(ledger.runtimeSnapshot('child')?.state,'completed');assert.equal(ledger.relation('child')?.runtimeStatus,'idle');
 assert.equal(Number(owner.database.prepare('SELECT count(*) AS n FROM opencraft_parent_notification_batches').get()!.n),1);
});
test('close drains transitions in FIFO order and restart recovers committed observations',async t=>{
 const {dir,owner,ledger,worker}=await fixture(t,true);
 const writes=[worker.observe(snapshot,1000),worker.observe({...snapshot,state:'completed'},2000),worker.observe({...snapshot,rootTurnId:'next',turnId:'next'},3000)];
 await worker.close();await Promise.all(writes);assert.equal(ledger.runtimeSnapshot('child')?.rootTurnId,'next');
 assert.equal(Number(owner.database.prepare('SELECT count(*) AS n FROM opencraft_parent_notification_batches').get()!.n),1);
 await assert.rejects(worker.observe(snapshot,4000),/closing/);
 const reopened=new OrchestrationRuntimeWorker(join(dir,'opencraft-server.sqlite'));await reopened.start();
 try{assert.ok((await reopened.targets(false,5000)).includes('child'));await reopened.observe({...snapshot,rootTurnId:'next',turnId:'next'},5000);assert.equal(ledger.runtimeSnapshot('child')?.rootTurnId,'next');}finally{await reopened.close();}
});
test('missing storage fails closed without creating a database or main-thread SQL fallback',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'orchestration-missing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const worker=new OrchestrationRuntimeWorker(join(dir,'missing.sqlite'));
 await assert.rejects(worker.start(),/unavailable/);await assert.rejects(worker.observe(snapshot,1000));await assert.rejects(worker.close());
});
