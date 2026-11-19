import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRtxAssociation,createRtxMemberEvidence,synchronizeRtxMembers} from '../../plugins/tencentoa/src/rtx-directory.mjs';
const store=claims=>{const rows=new Map();return {knownPrincipals:async()=>claims,read:async k=>rows.get(k)??null,evaluate:async(_script,[k],[old,next])=>{if((rows.get(k)??'')!==old)return 0;rows.set(k,next);return 1;}}};
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const now=1000;
const principal=(subject='110337',loginName='ruippan')=>({provider:'tencentoa',subject,displayName:'Not an identity',attributes:{loginName},aliases:['login:'+loginName.toLowerCase()],expiresAt:2000});
test('RTX is matched only against verified IOA login claims, never numeric staff ID or labels',()=>{
 const p=principal();
 assert.equal(resolveRtxAssociation('RUIPPAN',[p],null,now).identity.subject,'110337');
 for(const rtx of ['110337','Not an identity','skipzhang'])assert.equal(resolveRtxAssociation(rtx,[p],null,now).state,'unresolved');
 for(const invalid of [{...p,provider:'other'},{...p,aliases:[]},{...p,expiresAt:now},{...p,subject:'ruippan'}])
  assert.equal(resolveRtxAssociation('ruippan',[invalid],null,now).state,'unresolved');
});
test('conflicting claims, stored association reassignment and renamed employee fail closed',()=>{
 const p=principal();
 assert.equal(resolveRtxAssociation('ruippan',[p,principal('999')],null,now).state,'conflict');
 assert.equal(resolveRtxAssociation('ruippan',[principal('999')],p,now).state,'conflict');
 assert.equal(resolveRtxAssociation('ruippan',[principal('110337','newname')],p,now).state,'conflict');
 assert.equal(resolveRtxAssociation('ruippan',[p],{state:'conflict'},now).state,'conflict');
 assert.equal(resolveRtxAssociation('ruippan',[],p,now).state,'resolved');
});
test('member evidence requires current claims and authenticated raw-ID mapping',async()=>{
 const ids=[];const resolve=createRtxMemberEvidence(store([principal()]),async(_source,id)=>{ids.push(id);if(id!=='T03370011A')throw Error('not in directory');return 'ruippan';},()=>now);
 assert.deepEqual(await resolve(source,['T03370011A','110337','fwrobot','external:raw','unknown']),{source,members:[{userId:'T03370011A',rtx:'ruippan',subject:'110337',identity:principal(),expiresAt:2000}]});
 assert.deepEqual(ids,['T03370011A','110337','unknown']);
 const expired=createRtxMemberEvidence(store([{...principal(),expiresAt:now}]),async()=> 'ruippan',()=>now);
 assert.deepEqual((await expired(source,['T03370011A'])).members,[{userId:'T03370011A',rtx:'ruippan',subject:null,expiresAt:61000}]);
});
test('owner bridge uses exact existing Actor, preserves admission and never merges bindings',async()=>{
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),snapshot={externalId:'room',memberIds:['T03370011A']};
 const evidence={source,members:[{userId:'T03370011A',rtx:'ruippan',subject:'110337',expiresAt:2000}]};
 const actor={id:'existing',enabled:true,kind:'human',generation:7};let admitted=true,existing=null;const calls=[];
 const service={actors:{bindings:()=>[],findHuman:b=>b.provider==='tencentoa'?actor:existing},admittedActor:()=>admitted,synchronizeChannels:async c=>calls.push(c)};
 await synchronizeRtxMembers(service,source,snapshot,evidence,()=>now);
 assert.deepEqual(calls,[{method:'mirrorLink',params:{actorId:'existing',generation:7,corpId:'wxfixture',userId:'T03370011A'}}]);
 admitted=false;await synchronizeRtxMembers(service,source,snapshot,evidence,()=>now);assert.equal(calls.length,1);
 admitted=true;existing={id:'someone-else'};await synchronizeRtxMembers(service,source,snapshot,evidence,()=>now);assert.equal(calls.length,1);
 existing=null;await synchronizeRtxMembers(service,source,snapshot,evidence,()=>2000);assert.equal(calls.length,1);
 service.actors.bindings=()=>[{provider:'wecom.wxfixture',subject:'Tprevious'}];
 await synchronizeRtxMembers(service,source,snapshot,evidence,()=>now);assert.equal(calls.length,1,'rejoined RTX never adds a new userid to the historical Actor');
 await assert.rejects(synchronizeRtxMembers(service,source,snapshot,{...evidence,source:'other'},()=>now),/invalid/);
 await assert.rejects(synchronizeRtxMembers(service,source,snapshot,{...evidence,members:[...evidence.members,...evidence.members]},()=>now),/invalid/);
});

test('a claim expiring during directory lookup cannot seed an account association',async()=>{
 let reads=0;
 const resolve=createRtxMemberEvidence(store([principal()]),async()=> 'ruippan',()=>++reads===1?1999:2001);
 const result=await resolve(source,['T03370011A']);
 assert.equal(result.members[0].subject,null);
 assert.equal(result.members[0].identity,undefined);
});

test('durable association remains usable after the login session expires',async()=>{
 let clock=1000;const redis=store([principal()]);
 const resolve=createRtxMemberEvidence(redis,async()=> 'ruippan',()=>clock);
 await resolve(source,['T03370011A']);clock=40000;
 assert.deepEqual((await resolve(source,['T03370011A'])).members,[{userId:'T03370011A',rtx:'ruippan',subject:'110337',expiresAt:100000}]);
});


test('member isolation does not hide storage or transport failures',async()=>{
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
 const snapshot={externalId:'room',memberIds:['T10001A']},evidence={source,members:[{userId:'T10001A',rtx:'alice',subject:null,expiresAt:Date.now()+60000}]};
 for(const message of ['SQLITE_IOERR','Worker closed','Human reservation requires storage Worker']){
  const service={actors:{findHuman:()=>null},synchronizeChannels:async()=>{throw Error(message);}};
  await assert.rejects(synchronizeRtxMembers(service,source,snapshot,evidence),{message});
 }
});
