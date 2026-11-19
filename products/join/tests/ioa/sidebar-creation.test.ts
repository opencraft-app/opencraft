import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {ThreadCatalogPublisher} from '@opencraft/app-host-server/thread-catalog';
import {ThreadCatalogUpdates} from '../../../../apps/workbench-web/src/runtime/thread-catalog-updates';
import {TencentOaController} from '../../plugins/tencentoa/src/controller';
import {TencentOaCreatorGrouping} from '../../plugins/tencentoa/src/creator-grouping';
import {TencentOaParticipantsController, type ParticipantsClient} from '../../plugins/tencentoa/src/participants-controller';
const row = (id:string) => ({id,cwd:'/synthetic',createdAt:1,updatedAt:2,name:null,preview:'',ephemeral:false,status:{type:'idle'},turns:[]});
test('baseline: creation receipt and first turn paint before list catches up',()=>{
 const journal=new ThreadCatalogUpdates('h');journal.enabled=true;
 const publisher=new ThreadCatalogPublisher((_m,event)=>journal.receive(event),true);
 publisher.observeResult('thread/start',{}, {thread:row('new')});
 publisher.observeNotification('turn/started',{threadId:'new',turn:{id:'t'}});
 assert.equal(journal.project(undefined)?.data[0]?.id,'new');
});
test('notification-only creation produces a committed sidebar row',()=>{
 const journal=new ThreadCatalogUpdates('h');journal.enabled=true;const events:any[]=[];
 const publisher=new ThreadCatalogPublisher((_m,event)=>{events.push(event);journal.receive(event)},true);
 publisher.observeNotification('thread/started',{thread:row('external')});
 publisher.observeNotification('turn/started',{threadId:'external',turn:{id:'t'}});
 assert.equal(events.filter(e=>e.change.type==='upsert').length,1);
 assert.equal(journal.project(undefined)?.data[0]?.id,'external');
 assert.equal(events.at(-1)?.change.type,'patch');
});
test('My conversations displays authenticated creation without waiting for old metadata batch',async t=>{
 const identity=new TencentOaController((async()=>new Response(JSON.stringify({available:true,identity:{loginName:'alice',staffId:'11',expiresAt:new Date(Date.now()+60000).toISOString()}}))) as typeof fetch);await identity.refresh();
 const calls:string[][]=[];let release!:(v:unknown)=>void;
 const client={connectionGeneration:1,initializeResult:{capabilities:{extensions:{'opencraft/ioa/thread-participants/list':{version:1}}}},
 requestRaw:async (_method:string,{threadIds}:{threadIds:string[]})=>{calls.push(threadIds);if(calls.length===1)return new Promise(resolve=>{release=resolve});return {data:threadIds.map(threadId=>({threadId,revision:1,creator:'alice',participants:['alice']}))}},
 subscribeNotification:()=>()=>{},subscribeStatus:()=>()=>{},subscribeRequestLifecycle:()=>()=>{}} as unknown as ParticipantsClient;
 const participants=new TencentOaParticipantsController(()=>client);const grouping=new TencentOaCreatorGrouping(identity,participants,null);const stops:(()=>void)[]=[];
 t.after(()=>{stops.forEach(stop=>stop());grouping.dispose();participants.dispose();identity.dispose()});grouping.setFilterEnabled(true);
 const old=Array.from({length:100},(_,i)=>({hostId:'h',threadId:'old-'+i,updatedAt:1}));stops.push(grouping.watch(old));await tick();
 const fresh={hostId:'h',threadId:'new',updatedAt:3,createdByViewer:true};stops.push(grouping.watch([fresh]));await tick();
 assert.equal(calls.length,1,'new metadata request waits behind old request');
 assert.deepEqual(grouping.filterThreads([fresh]),[fresh],'trusted creation evidence is independent of participant read latency');
 assert.deepEqual(grouping.filterThreads([{...fresh,createdByViewer:undefined}]),[],'unknown legacy relation is not invented');
 assert.deepEqual(grouping.filterThreads([{...fresh,createdByViewer:false}]),[],'another creator does not establish participation');
 release({data:old.map(r=>({threadId:r.threadId,revision:1,creator:'alice',participants:['alice']}))});await tick();await tick();
 assert.deepEqual(calls[1],['new']);assert.deepEqual(grouping.filterThreads([fresh]),[fresh]);
});
