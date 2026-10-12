import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/store.js';
import {GroupPolicies} from '../dist/groups.js';
import {buildApp} from '../dist/app.js';

test('group policy follows real membership, preserves mixed mode, and enforces owner/admin rights',async()=>{
 const store=new Store(':memory:');const owner=store.owner('group-fixture','fixture');
 const a=store.addIdentity(owner.id,'Alpha','agent','a_alpha'),b=store.addIdentity(owner.id,'Beta','agent','a_beta');
 const human=store.addIdentity(owner.id,'Human with opaque ID','human','a_opaque_human');
 let members=[{Member_Account:a.id,Role:'Owner'},{Member_Account:b.id,Role:'Member'}];
 const call=async(_c,command,body)=>{
  if(command.endsWith('/get_group_info'))return {GroupInfo:[{Type:'Public',ErrorCode:0}]};
  assert(command.endsWith('/get_group_member_info'));return {MemberNum:members.length,MemberList:members.slice(body.Offset,body.Offset+body.Limit)};
 };
 const groups=new GroupPolicies({},store,call);
 try{
  let policy=await groups.read('@TGS#fixture',a.id);assert.equal(policy.groupKind,'bot');assert.equal(policy.effectiveMode,'all');
  await groups.update('@TGS#fixture',a.id,'mention_context');
  await assert.rejects(groups.update('@TGS#fixture',b.id,'all'),e=>e.statusCode===403);
  await assert.rejects(groups.read('@TGS#fixture',human.id),e=>e.statusCode===403);
  members.push({Member_Account:human.id,Role:'Admin'});
  policy=await groups.read('@TGS#fixture',a.id);assert.equal(policy.groupKind,'mixed');assert.equal(policy.effectiveMode,'mention_context');assert.equal(policy.contextMessages,10);
  await groups.update('@TGS#fixture',human.id,'all');assert.equal((await groups.read('@TGS#fixture',b.id)).effectiveMode,'all');
  await groups.update('@TGS#fixture',human.id,'mention');assert.equal((await groups.read('@TGS#fixture',b.id)).contextMessages,0);
  await assert.rejects(groups.update('@TGS#fixture',a.id,'bogus'),e=>e.statusCode===400);
  members=members.filter(m=>m.Member_Account!==human.id);assert.equal((await groups.read('@TGS#fixture',b.id)).effectiveMode,'all');
  assert.equal((await new GroupPolicies({},store,call).read('@TGS#fixture',a.id)).mode,'mention');
 }finally{store.close()}
});

test('classification reads every page and treats unregistered members as human',async()=>{
 const store=new Store(':memory:');const owner=store.owner('pages','pages');
 const members=Array.from({length:101},(_,i)=>({Member_Account:store.addIdentity(owner.id,'Bot '+i,'agent').id,Role:i===0?'Owner':'Member'}));
 members.push({Member_Account:'a_unknown_external',Role:'Member'});const offsets=[];
 const groups=new GroupPolicies({},store,async(_c,command,body)=>{
  if(command.endsWith('/get_group_info'))return {GroupInfo:[{Type:'Public'}]};
  offsets.push(body.Offset);return {MemberNum:members.length,MemberList:members.slice(body.Offset,body.Offset+70)};
 });
 try{const p=await groups.read('group',members[0].Member_Account);assert.equal(p.groupKind,'mixed');assert.equal(p.memberCount,102);assert.deepEqual(offsets,[0,70]);
  const incomplete=new GroupPolicies({},store,async(_c,command)=>command.endsWith('/get_group_info')?{GroupInfo:[{Type:'Public'}]}:{MemberNum:members.length,MemberList:[]});
  await assert.rejects(incomplete.read('group',members[0].Member_Account),e=>e.statusCode===503);
 }finally{store.close()}
});

test('group policy HTTP routes require identity credentials',async()=>{
 const store=new Store(':memory:');const owner=store.owner('http','http');const human=store.addIdentity(owner.id,'Human','human');
 const c={appId:1,imSecret:'fixture',admin:'fixture',host:'127.0.0.1',port:0,dataDir:'unused',ssoSecret:'',allowedOrigins:[],demoMode:false,webDir:'/none'};
 const groups=new GroupPolicies(c,store,async(_c,command)=>command.endsWith('/get_group_info')?{GroupInfo:[{Type:'Public'}]}:{MemberNum:1,MemberList:[{Member_Account:human.id,Role:'Owner'}]});
 const {app}=await buildApp(c,{store,groupPolicies:groups});const peer=store.token(owner.id,human.id),ownerToken=store.token(owner.id,null);
 const url='/api/groups/%40TGS%23fixture/reply-policy';
 try{
  assert.equal((await app.inject({url})).statusCode,401);
  assert.equal((await app.inject({url,headers:{authorization:'Bearer '+ownerToken.token}})).statusCode,403);
  const r=await app.inject({url,method:'PUT',payload:{mode:'mention_context'},headers:{authorization:'Bearer '+peer.token}});assert.equal(r.statusCode,200);assert.equal(r.json().contextMessages,10);
 }finally{await app.close()}
});
