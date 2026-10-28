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
