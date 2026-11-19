import test from 'node:test';
import assert from 'node:assert/strict';
import {createGroupSyncPump} from '../../plugins/wecom/mirror/group-sync-target.mjs';
for(const policy of [{config:{members:'observe'}},{paused:true,config:{members:'both'}},{observationOnly:true,config:{members:'both'}},{config:{members:'both'}}])test('member binding rechecks current policy '+JSON.stringify(policy),async()=>{
 let reads=0,linked=0;
 const pump=createGroupSyncPump({linkMembers:async()=>{linked++},call:async(method)=>{
  switch(method.split('/').at(-1)){
   case 'list':return[{source:'source',sourceEpoch:'epoch',pollMs:30000}];
   case 'read':return ++reads===1?{config:{members:'both'}}:policy;
   case 'begin':return{};case 'claim':return null;case 'observe':return{observation:1,sequence:0};
  }
 },request:async()=>({snapshot:{externalId:'room',name:'Named',memberIds:[]},memberEvidence:{source:'source',members:[]}}),onError:e=>{throw e}});
 await pump.poll();await pump.close();assert.equal(linked,!policy.paused&&!policy.observationOnly&&policy.config.members==='both'?1:0);
});
