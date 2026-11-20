import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ThreadCatalogPublisher} from '@opencraft/app-host-server/thread-catalog';
import {ProvisionalThreads} from '../../apps/opencraft-daemon/src/provisional-threads';
const row=(id:string)=>({id,cwd:'/synthetic',createdAt:1,updatedAt:2,name:null,preview:'',ephemeral:false,status:{type:'idle'},turns:[]});
const empty=()=>({data:[],nextCursor:null});
test('metadata and acceptance commute; duplicates cannot reallocate a committed row',()=>{
 for(const reverse of [false,true]) {
  const events:any[]=[];const p=new ThreadCatalogPublisher((_m,e)=>events.push(e),true);
  const start=()=>p.observeNotification('thread/started',{thread:row('new')});
  const accept=()=>p.observeNotification('turn/started',{threadId:'new',turn:{id:'first'}});
  if(reverse){accept();assert.equal((p.projectList({},empty()) as any).data.length,0);start()}else{start();accept()}
  p.observeResult('thread/start',{}, {thread:row('new')});accept();start();
  assert.equal(events.filter(e=>e.change.type==='upsert').length,1);
  assert.equal((p.projectList({},empty()) as any).data[0].id,'new');
  p.observeNotification('thread/deleted',{threadId:'new'});start();accept();
  assert.equal((p.projectList({},empty()) as any).data.length,0);
 }
});
test('durable acceptance recovers across publisher/store restart without repeating creation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-evidence-'));let store=new ProvisionalThreads(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 let p=new ThreadCatalogPublisher(()=>{},true,()=>store.catalog);
 p.observeNotification('thread/started',{thread:row('new')});
 p.observeNotification('turn/started',{threadId:'new',turn:{id:'first'}});
 assert.equal(store.get('new'),null,'notifications cannot prove a recoverable empty creation or bind its environment');
 store.created('new',{thread:row('new'),model:'synthetic-model'},'environment-owner');
 assert.equal(store.get('new')?.phase,'accepted');assert.equal(store.get('new')?.inputId,null);
 assert.equal(store.get('new')?.result.model,'synthetic-model');assert.equal(store.get('new')?.environmentOwner,'environment-owner');
 store.created('new',{thread:row('new'),model:'duplicate'},'different-owner');
 assert.equal(store.get('new')?.result.model,'synthetic-model');assert.equal(store.get('new')?.environmentOwner,'environment-owner');
 store.accepted('new','wrong-later-input','later');assert.equal(store.get('new')?.inputId,null);
 store.accepted('new','input','first');store.accepted('new','duplicate','later');
 assert.equal(store.get('new')?.inputId,'input');assert.equal(store.get('new')?.turnId,'first');
 store.close();store=new ProvisionalThreads(dir);p=new ThreadCatalogPublisher(()=>{},true,()=>store.catalog);
 assert.equal((p.projectList({},empty()) as any).data.length,0,'restart alone cannot resurrect a row archived by another owner while offline');
 p.observeNotification('thread/started',{thread:row('new')});
 const recovered=p.projectList({},empty()) as any;
 assert.equal(recovered.data[0].id,'new');assert.equal(store.get('new')?.phase,'accepted');
 p.observeNotification('thread/archived',{threadId:'new'});
 store.close();store=new ProvisionalThreads(dir);p=new ThreadCatalogPublisher(()=>{},true,()=>store.catalog);
 assert.equal((p.projectList({},empty()) as any).data.length,0,'archive survives restart');
 p.observeNotification('thread/started',{thread:row('new')});p.observeNotification('turn/started',{threadId:'new',turn:{id:'late'}});
 assert.equal((p.projectList({},empty()) as any).data.length,0,'late notifications cannot resurrect archive');
});
test('preexisting recovery rows do not become a new directory on migration',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-legacy-'));const store=new ProvisionalThreads(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 store.created('old',{thread:row('old')});store.accepted('old','input','turn');
 const p=new ThreadCatalogPublisher(()=>{},true,()=>store.catalog);
 assert.equal((p.projectList({},empty()) as any).data.length,0);
});

test('an attempted input is not the accepted input; confirmed acceptance remains immutable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-attempt-'));const store=new ProvisionalThreads(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 store.created('new',{thread:row('new')});store.attempted('new','unconfirmed');
 store.accepted('new','confirmed','first');store.accepted('new','later','second');
 assert.equal(store.get('new')?.inputId,'confirmed');assert.equal(store.get('new')?.turnId,'first');
});

test('a failed catalog journal cannot turn native success into an RPC failure',()=>{
 const events:any[]=[];let failures=0;
 const fail=()=>{throw new Error('synthetic journal failure')};
 const p=new ThreadCatalogPublisher((_m,e)=>events.push(e),true,()=>({allocate:fail,read:fail,accept:fail,patch:fail,retire:fail,committed:fail}),()=>{failures++});
 assert.doesNotThrow(()=>p.observeResult('thread/start',{}, {thread:row('new')}));
 assert.doesNotThrow(()=>p.observeNotification('turn/started',{threadId:'new',turn:{id:'first'}}));
 const native=empty();assert.equal(p.projectList({},native),native);
 assert.equal(events.filter(e=>e.change.type==='upsert').length,0);
 assert.equal(events.filter(e=>e.change.type==='invalidate').length,2);assert.equal(failures,3);
});

test('removal before metadata cannot resurrect a conversation, including after owner restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-remove-'));let store=new ProvisionalThreads(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 for (const durable of [false,true]) {
  let p=new ThreadCatalogPublisher(()=>{},true,durable?()=>store.catalog:undefined);
  p.observeNotification('thread/deleted',{threadId:'gone'});
  if(durable){store.close();store=new ProvisionalThreads(dir);p=new ThreadCatalogPublisher(()=>{},true,()=>store.catalog)}
  p.observeNotification('thread/started',{thread:row('gone')});
  p.observeNotification('turn/started',{threadId:'gone',turn:{id:'late'}});
  assert.equal((p.projectList({},empty()) as any).data.length,0);
  assert.equal(store.get('gone'),null);
 }
});
test('completion before metadata cannot paint stale acceptance as running',()=>{
 const p=new ThreadCatalogPublisher(()=>{},true);
 p.observeNotification('turn/started',{threadId:'new',turn:{id:'first'}});
 p.observeNotification('turn/completed',{threadId:'new',turn:{id:'first'}});
 p.observeNotification('turn/started',{threadId:'new',turn:{id:'first'}});
 p.observeResult('turn/start',{threadId:'new'},{turn:{id:'first'}});
 p.observeNotification('thread/started',{thread:row('new')});
 assert.equal((p.projectList({},empty()) as any).data[0].status.type,'idle');
});
