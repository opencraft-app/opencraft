import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createDshNativeOwner} from '../../apps/local-agent-host/src/dsh-native-owner.mjs';
import {DshOwnerHandoff} from '../../scripts/server-deployment/dsh-owner-handoff.mjs';

test('native reconciliation cannot enter between release observation and writer stop',async t=>{
 const root=await mkdtemp('/tmp/dsh-release-');t.after(()=>rm(root,{recursive:true,force:true}));
 const native=createDshNativeOwner({settings:{describe:()=>[]},jobs:{list:()=>[]},agents:{list:()=>[],get:()=>null},sessions:{flush:async()=>{}},sessionPersistence:{list:async()=>[]}},root);
 native.resume();await mkdir(root+'/owner-handoff');let attempted=false,closed=false;
 const owner=new DshOwnerHandoff(root,{},()=>({coverage:'complete',activeCount:0}));await owner.load();
 owner.attach({engineProcessId:process.pid,nativeOwner:async(action:string)=>{
   if(action==='fence')native.fence();if(action==='seal-release')native.sealRelease();if(action==='abort-release')native.abortRelease();return native.inspect();
 },handoffObservation:async()=>{
   if(attempted){const r=await native.rpc('session.cancel',{rpcId:'racing-cancel'},async()=>Response.json({accepted:true}));assert.equal(r.status,409);}
   return {coverage:'complete',activeCount:0};
 },close:async()=>{assert.equal((await native.inspect()).activeCount,0);closed=true;}});
 const expectation=()=>({expectedOwner:owner.authority.owner,expectedEpoch:owner.authority.snapshot().epoch,operationId:'release-test',fence:'release-test'});
 await owner.control('fence',expectation());attempted=true;
 assert.equal((await owner.control('release',expectation())).released,true);assert.equal(closed,true);
});

test('sealed unknown responsibility survives a successor; exact mismatch and new live work reject readiness',async t=>{
 const root=await mkdtemp('/tmp/dsh-carry-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(root+'/owner-handoff');
 const one={sessionId:'s',resultSeq:2,toolCallSeq:1,storedEvents:4,storedDigest:'digest'};
 let list=[one],active=1,closed=false;
 const host={engineProcessId:process.pid,nativeOwner:async()=>({pid:process.pid,owner:'native',configuration:'settings',coverage:'complete',activeCount:active,records:[{transferableUnknown:list}]}),
  handoffObservation:async()=>({coverage:'complete',activeCount:0}),coldReadResources:async()=>({}),close:async()=>{closed=true;},resumeBackground:()=>{}};
 const make=async()=>{const owner=new DshOwnerHandoff(root,{},()=>({coverage:'complete',activeCount:0}));await owner.load();owner.attach(host);return owner;};
 const exp=(owner:any)=>({expectedOwner:owner.authority.owner,expectedEpoch:owner.authority.snapshot().epoch,operationId:'carry',fence:'carry'});
 let owner=await make();await owner.control('fence',exp(owner));
 const released=await owner.control('release',exp(owner));assert.equal(closed,true);assert.deepEqual(released.carriedUnknown,[one]);
 owner=await make();let ready=await owner.control('cold-ready',exp(owner));assert.equal(ready.occupancy.activeCount,0);assert.deepEqual(ready.occupancy.carriedUnknown,[one]);
 for(const changed of [[{...one,storedDigest:'changed'}],[],[one,{...one,resultSeq:9}]]){
   list=changed;active=list.length;
   await assert.rejects(owner.control('cold-ready',exp(owner)));
   await assert.rejects(owner.control('resume',{...exp(owner),identity:ready.handoff.ready.identity}));
 }
 list=[one];active=2;await assert.rejects(owner.control('cold-ready',exp(owner)),/incomplete/);
 list=[];active=1;await assert.rejects(owner.control('cold-ready',exp(owner)),/incomplete/);
 list=[one];active=1;ready=await owner.control('cold-ready',exp(owner));
 await owner.control('resume',{...exp(owner),identity:ready.handoff.ready.identity});
 assert.equal(owner.open(),true);assert.deepEqual((await owner.inspect()).carriedUnknown,[one]);
});
