import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../dist/store.js';
import {DemoDirectory} from '../dist/demo.js';
import {buildApp} from '../dist/app.js';

test('demo creates a fresh visitor, preserves session isolation and exposes only demo peers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-demo-'));const store=new Store(join(dir,'demo.sqlite'));
 const c={appId:1600166071,imSecret:'test',admin:'administrator',restHost:'unused',host:'127.0.0.1',port:0,dataDir:dir,ssoSecret:'',ssoIssuer:'unused',ssoAudience:'unused',allowedOrigins:[],demoMode:true,webDir:'/none'};
 const fixtureOwner=store.owner('fixture','fixture');const alpha=store.addIdentity(fixtureOwner.id,'Alpha','agent');const beta=store.addIdentity(fixtureOwner.id,'Beta','agent');
 const production=store.addIdentity(store.owner('production','production').id,'Production','human');
 const pairs=new Set();const directory=new DemoDirectory(c,store,async(_c,command,body)=>{
  assert.equal(command,'sns/friend_add');assert.equal(body.AddType,'Add_Type_Both');assert.equal(body.ForceAddFlags,1);
  for(const item of body.AddFriendItem){pairs.add(body.From_Account+'>'+item.To_Account);pairs.add(item.To_Account+'>'+body.From_Account)}
  return {ResultItem:body.AddFriendItem.map(i=>({To_Account:i.To_Account,ResultCode:0}))};
 });
 await directory.enroll(alpha.id);await directory.enroll(beta.id);
 const {app}=await buildApp(c,{store,provision:async()=>{},demoEnroll:id=>directory.enroll(id)});
 const request=(url,token,body)=>app.inject({method:body===undefined?'GET':'POST',url,payload:body,headers:token?{authorization:`Bearer ${token}`}:{}});
 try{
  const a=(await request('/api/auth/demo',null,{name:'Same name'})).json();const b=(await request('/api/auth/demo',null,{name:'Same name'})).json();
  assert.notEqual(a.ownerId,b.ownerId);assert.notEqual(a.identities[0].id,b.identities[0].id);
  const peers=(await request('/api/demo/participants',a.token)).json().participants;
  assert.equal(peers.length,4);assert(!peers.some(p=>p.id===production.id));assert(peers.every(p=>!('ownerId' in p)));
  for(const p of peers)for(const q of peers)if(p.id!==q.id)assert(pairs.has(p.id+'>'+q.id));
  const forbidden=await request('/api/identities/'+b.identities[0].id+'/tokens',a.token,{});assert.equal(forbidden.statusCode,404);
  const extra=(await request('/api/identities',a.token,{name:'My Agent',kind:'agent'})).json();assert(store.isDemoIdentity(extra.id));
  assert.equal((await request('/api/demo/participants')).statusCode,401);
  const outsider=store.token(production.ownerId,production.id);assert.equal((await request('/api/demo/participants',outsider.token)).statusCode,403);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('demo friendships stay under the Tencent per-account cap, never release pinned Agents and tolerate a full account',async()=>{
 const store=new Store(':memory:');const owner=store.owner('cap','cap');
 const ids=Array.from({length:8},(_,i)=>store.addIdentity(owner.id,'P'+i,i<2?'agent':'human').id);
 const friends=new Map();const link=(a,b,on)=>{for(const [x,y] of [[a,b],[b,a]]){const s=friends.get(x)??new Set();on?s.add(y):s.delete(y);friends.set(x,s)}};
 const full=new Set();
 const call=async(_c,command,body)=>{
  if(command==='sns/friend_delete'){for(const to of body.To_Account)link(body.From_Account,to,false);return {}}
  return {ResultItem:body.AddFriendItem.map(({To_Account})=>{if(full.has(To_Account))return {To_Account,ResultCode:30014};link(body.From_Account,To_Account,true);return {To_Account,ResultCode:0}})};
 };
 const demo=new DemoDirectory({demoMode:true,demoPinned:[ids[0],ids[1]],demoFriendLimit:4,demoRecentFriends:2},store,call);
 try{
  for(const id of ids.slice(0,7))await demo.enroll(id);
  for(const [id,set] of friends)assert(set.size<=4,`${id} has ${set.size} friends`);
  assert(friends.get(ids[0]).has(ids[1]),'pinned Agents are never released from each other');
  // Hermes accounts are capped too: the most recent visitors keep them, older demo pairs are released first.
  for(const id of ids.slice(5,7))assert(friends.get(id).has(ids[0])&&friends.get(id).has(ids[1]),'recent visitors are friends with both pinned Agents');
  full.add(ids[6]);await demo.enroll(ids[7]);assert(store.isDemoIdentity(ids[7]),'a full account is skipped, enrollment still succeeds');
 }finally{store.close()}
});

test('demo enrollment is disabled in production and surfaces partial Tencent friendship failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-demo-fail-'));const store=new Store(join(dir,'demo.sqlite'));const owner=store.owner('one','one');const a=store.addIdentity(owner.id,'A','agent');const b=store.addIdentity(owner.id,'B','agent');
 try{
  let calls=0;const call=async()=>{calls++;return {ResultItem:[{ResultCode:30010,ResultInfo:'friend limit'}]}};
  await assert.rejects(new DemoDirectory({demoMode:false},store,call).enroll(a.id),/disabled/);assert.equal(calls,0);
  const demo=new DemoDirectory({demoMode:true},store,call);await demo.enroll(a.id);await assert.rejects(demo.enroll(b.id),/friend limit/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
