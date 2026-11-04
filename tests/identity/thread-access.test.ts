import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { ThreadAccessStore, ThreadAccessSession, THREAD_ACCESS_SET, THREAD_ACCESS_READ } from '../../packages/access-control/src/thread-access';
import { Collaboration } from '../../packages/access-control/src/collaboration';
import { parsePrincipal } from '../../packages/identity-core/src/index';

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(),'thread-access-'));
  const actors = new ActorStore(join(dir,'actors.sqlite'));
  const human = (subject: string) => {
    const context=actors.resolveHuman(parsePrincipal({provider:'local',subject,displayName:subject,expiresAt:Date.now()+60_000}));
    assert.ok(context);return context;
  };
  const alice = human('alice'), bob = human('bob');
  let store = new ThreadAccessStore(join(dir,'policy.sqlite'),actors);
  const sessions: ThreadAccessSession[] = [];
  const lane = (context: typeof alice | undefined, server = 'server') => {
    const out: any[] = [];
    const session = new ThreadAccessSession(store,(_id,override) => override ?? server,context,frame => out.push(JSON.parse(frame)));
    sessions.push(session);
    return {session,out, async request(method: string,params: unknown = {},id = 1) {
      const consumed = await session.receive(JSON.stringify({id,method,params}));
      return {consumed,response:out.findLast(row => row.id === id)};
    }, result(id: number,result: unknown) { const frame = session.project(JSON.stringify({id,result})); return frame === null ? null : JSON.parse(frame); }};
  };
  t.after(async () => { for(const s of sessions)s.close();store.close();actors.close();await rm(dir,{recursive:true,force:true}); });
  return {actors,alice,bob,lane,get store(){return store;},restart(){store.close();store=new ThreadAccessStore(join(dir,'policy.sqlite'),actors);}};
}

test('only immutable creator can change policy; unknown historical and anonymous conversations cannot be claimed',async t => {
  const f = await fixture(t); f.store.created('server','thread',f.alice);
  assert.throws(() => f.store.set('server','thread','private',1,f.bob));
  assert.throws(() => f.store.set('server','legacy','private',1,f.alice));
  f.store.created('server','anonymous');f.store.created('server','anonymous',f.alice);
  assert.equal(f.store.projection('server','anonymous',f.alice).canChangeAccess,false);
  f.store.created('server','thread',f.bob);
  assert.equal(f.store.read('server','thread').creatorActorId,f.alice.actorId);
  f.store.set('server','thread','private',1,f.alice);
  assert.equal(f.store.allows('server','thread',f.bob),false);
  assert.equal(f.store.allows('server','thread',f.alice),true);
  assert.equal(f.store.allows('server','thread'),false);
  assert.equal(f.store.allows('other-server','thread',f.bob),true);
  assert.throws(() => f.store.set('server','thread','shared',1,f.alice), /refresh/);
  f.restart();assert.equal(f.store.read('server','thread').accessMode,'private');
});

test('creation uses trusted context, fork is independent and client creator fields confer no ownership',async t => {
  const f = await fixture(t), alice=f.lane(f.alice),bob=f.lane(f.bob);
  await alice.request('thread/start',{creatorActorId:f.bob.actorId});
  alice.result(1,{thread:{id:'parent',name:'parent'}});
  f.store.set('server','parent','private',1,f.alice);
  await bob.request('thread/start');bob.result(1,{thread:{id:'child',parentThreadId:'parent'}});
  assert.equal(f.store.read('server','child').accessMode,'shared');
  assert.equal(f.store.read('server','parent').creatorActorId,f.alice.actorId);
});

test('private metadata is absent from list, search, pinned discovery and loaded IDs; empty pages remain valid',async t => {
  const f=await fixture(t),bob=f.lane(f.bob);f.store.created('server','secret',f.alice);f.store.set('server','secret','private',1,f.alice);
  for (const method of ['thread/list','thread/search','opencraft/thread-pins/list','thread/loaded/list']) {
    await bob.request(method);
    const secret=method==='thread/loaded/list'?'secret':method==='thread/search'?{thread:{id:'secret',name:'SECRET'},snippet:'SECRET'}:{id:'secret',name:'SECRET'};
    assert.deepEqual(bob.result(1,{data:[secret],nextCursor:null,totalCount:1}).result,{data:[],nextCursor:null});
  }
  await bob.request('thread/list');assert.deepEqual(bob.result(1,{data:[{id:'visible',name:'Visible'},{id:'secret',name:'SECRET'}],nextCursor:'opaque'}).result.data,[{id:'visible',name:'Visible',accessMode:'shared'}]);
  await bob.request('thread/searchOccurrences',{threadId:'visible'});
  assert.equal(bob.result(1,{data:[{turnId:'turn',snippet:'match'}]}).result.data.length,1);
});

test('direct reads and writes reject before native execution; async results and subscriptions are revoked',async t => {
  const f=await fixture(t),bob=f.lane(f.bob),fresh=f.lane(f.bob);f.store.created('server','secret',f.alice);
  await bob.request('thread/read',{threadId:'secret'});bob.result(1,{thread:{id:'secret',name:'SECRET'}});
  await bob.request('thread/turns/list',{threadId:'secret'},2);
  f.store.set('server','secret','private',1,f.alice);
  assert.equal(bob.out.some(row=>row.method==='opencraft/thread-access/revoked'),true);
  assert.equal(fresh.out.some(row=>row.params?.threadId==='secret'),false,'unseen visitors learn no private ID');
  assert.equal(bob.result(2,{data:[{text:'SECRET'}]}).error.code,-32004);
  assert.equal(bob.session.project(JSON.stringify({method:'thread/name/updated',params:{threadId:'secret',name:'SECRET'}})),null);
  assert.equal(bob.session.project(JSON.stringify({method:'opencraft/thread-catalog/changed',params:{change:{type:'upsert',thread:{id:'secret',name:'SECRET'}}}})),null);
  for(const method of ['thread/read','thread/name/set','turn/start','thread/queue/list','thread/delete']) {
    const result=await bob.request(method,{threadId:'secret'});assert.equal(result.consumed,true);assert.equal(result.response.error.code,-32004);
  }
  assert.equal(JSON.stringify(bob.out).includes('SECRET'),false);
});

test('server computes canChangeAccess, checks CAS, and reopening does not grant another editor',async t => {
  const f=await fixture(t),alice=f.lane(f.alice),bob=f.lane(f.bob);f.store.created('server','thread',f.alice);
  assert.equal((await bob.request(THREAD_ACCESS_READ,{threadId:'thread'})).response.result.canChangeAccess,false);
  assert.equal((await bob.request(THREAD_ACCESS_SET,{threadId:'thread',accessMode:'private',expectedRevision:1})).response.error.code,-32004);
  assert.equal((await alice.request(THREAD_ACCESS_SET,{threadId:'thread',accessMode:'private',expectedRevision:1})).response.result.revision,2);
  assert.equal((await alice.request(THREAD_ACCESS_SET,{threadId:'thread',accessMode:'shared',expectedRevision:1})).response.error.code,-32009);
  assert.equal((await alice.request(THREAD_ACCESS_SET,{threadId:'thread',accessMode:'shared',expectedRevision:2})).response.result.accessMode,'shared');
  assert.equal(f.store.projection('server','thread',f.bob).canChangeAccess,false);
});

test('task links and participant batches cannot expose private metadata; another server remains independent',async t=>{
  const f=await fixture(t),bob=f.lane(f.bob);f.store.created('server','secret',f.alice);f.store.set('server','secret','private',1,f.alice);
  assert.equal((await bob.request('opencraft/ioa/thread-participants/list',{threadIds:['secret']})).consumed,true);
  await bob.request('tasks/read');
  const result=bob.result(1,{title:'Independent task',conversations:[{serverId:'server',threadId:'secret',title:'SECRET'},{serverId:'other',threadId:'secret',title:'Other'}]});
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  assert.equal(result.result.conversations.length,1);
});

test('cross-conversation tools obey private policy even with an existing explicit grant',async t=>{
  const f=await fixture(t);f.store.created('server','secret',f.alice);f.store.set('server','secret','private',1,f.alice);
  const execution:any={hostId:'h',serverId:'server'};
  const service=new Collaboration(join(tmpdir(),`thread-access-collab-${crypto.randomUUID()}.sqlite`),f.actors,execution,Date.now,()=>true,(context,ref)=>f.store.allows(ref.serverId,ref.threadId,context));
  t.after(()=>service.close());
  assert.equal(service.conversationAllowed(f.alice,{serverId:'server',threadId:'secret'},'conversation.read'),true);
  assert.equal(service.conversationAllowed(f.bob,{serverId:'server',threadId:'secret'},'conversation.read'),false);
  f.actors.setGrant(f.bob.actorId,encodeConversationRef({serverId:'server',threadId:'secret'}),'conversation.read',true,f.alice.actorId);
  assert.equal(service.conversationAllowed(f.bob,{serverId:'server',threadId:'secret'},'conversation.read'),false);
});

test('revoked approval responses and uncorrelated directory responses cannot bypass access',async t=>{
  const f=await fixture(t),bob=f.lane(f.bob);f.store.created('server','thread',f.alice);
  assert.ok(bob.session.project(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',command:'synthetic'}})));
  f.store.set('server','thread','private',1,f.alice);
  assert.equal(await bob.session.receive(JSON.stringify({id:'approval',result:{decision:'accept'}})),true);
  assert.equal(bob.session.project(JSON.stringify({id:'unmatched',result:{data:[{id:'thread',name:'SECRET'}]}})),null);
  await bob.request('thread/read',{threadId:'missing'},99);
  const missing=bob.session.project(JSON.stringify({id:99,error:{code:-32600,message:'Thread missing not found',data:{code:'THREAD_NOT_FOUND'}}}));
  assert.equal(JSON.parse(missing!).error.code,-32004);
});


test('catalog categories use trusted policy for paged lists and upserts, never provider hints', async t => {
  const f=await fixture(t),alice=f.lane(f.alice),bob=f.lane(f.bob);
  f.store.created('server','mine',f.alice); f.store.set('server','mine','private',1,f.alice);
  const rows=[{id:'mine',cwd:'/work',updatedAt:1,accessMode:'shared'},{id:'public',cwd:'/work',updatedAt:2,accessMode:'private'}];
  await alice.request('thread/list');
  const own=alice.result(1,{data:structuredClone(rows),nextCursor:'page2'}).result;
  assert.deepEqual(own.data.map((row:any)=>[row.id,row.accessMode]),[['mine','private'],['public','shared']]);
  assert.equal(own.nextCursor,'page2');
  await bob.request('thread/list');
  assert.deepEqual(bob.result(1,{data:structuredClone(rows)}).result.data.map((row:any)=>[row.id,row.accessMode]),[['public','shared']]);
  const upsert=JSON.stringify({method:'opencraft/thread-catalog/changed',params:{change:{type:'upsert',thread:rows[0]}}});
  assert.equal(JSON.parse(alice.session.project(upsert)!).params.change.thread.accessMode,'private');
  assert.equal(bob.session.project(upsert),null);
  f.store.set('server','mine','shared',2,f.alice);
  assert.equal(JSON.parse(alice.session.project(upsert)!).params.change.thread.accessMode,'shared');
});


test('a directory frame reads each authoritative policy once, without retaining decisions for the next frame', async t => {
  const f=await fixture(t),bob=f.lane(f.bob);
  const data=Array.from({length:100},(_,i)=>({id:`directory-${i}`,cwd:'/workspace',updatedAt:1}));
  const read=f.store.read.bind(f.store);
  const reads=t.mock.method(f.store,'read',(...args:Parameters<typeof read>)=>read(...args));
  await bob.request('thread/list');
  const result=bob.result(1,{data,threads:data});
  assert.equal(result.result.data.length,100);
  assert.equal(result.result.threads.length,100);
  assert.equal(reads.mock.callCount(),100,'one policy lookup per unique server/thread in a synchronous frame');
  reads.mock.resetCalls();
  await bob.request('thread/list');
  bob.result(1,{data});
  assert.equal(reads.mock.callCount(),100,'the next frame must read current policies again');
});


test('frame-local policy reads distinguish servers and resolve changes again on the next frame',async t=>{
  const f=await fixture(t);
  f.store.created('private-server','same',f.alice);
  f.store.set('private-server','same','private',1,f.alice);
  let server='shared-server',resolutions=0;
  const session=new ThreadAccessSession(f.store,(_id,override)=>{resolutions++;return override??server;},f.bob,()=>{});
  t.after(()=>session.close());
  const request=JSON.stringify({id:1,method:'thread/list',params:{}});
  const response=JSON.stringify({id:1,result:{data:[{id:'same',cwd:'/workspace',updatedAt:1}]}});
  await session.receive(request);
  assert.equal(JSON.parse(session.project(response)!).result.data.length,1);
  assert.equal(resolutions,1,'filtering, classification and tracking share one server resolution');
  server='private-server';
  await session.receive(request);
  assert.deepEqual(JSON.parse(session.project(response)!).result.data,[]);
  await session.receive(JSON.stringify({id:2,method:'custom/references',params:{}}));
  const mixed=session.project(JSON.stringify({id:2,result:{references:[
    {threadId:'same',serverId:'private-server'},{threadId:'same',serverId:'shared-server'},
  ]}}));
  assert.deepEqual(JSON.parse(mixed!).result.references,[{threadId:'same',serverId:'shared-server'}]);
});

test('a private owner loses visibility immediately when its actor generation is revoked between frames',async t=>{
  const f=await fixture(t),alice=f.lane(f.alice);
  f.store.created('server','private',f.alice);f.store.set('server','private','private',1,f.alice);
  await alice.request('thread/list');
  assert.equal(alice.result(1,{data:[{id:'private'}]}).result.data.length,1);
  f.actors.setEnabled(f.alice.actorId,false,'test-operator');
  await alice.request('thread/list');
  assert.deepEqual(alice.result(1,{data:[{id:'private'}]}).result.data,[]);
});


test('unadmitted Merkle summaries cannot leak private directory counts or fingerprints', async t => {
  const f=await fixture(t),session=f.lane(f.alice).session;
  const initialize={id:901,method:'initialize',params:{}};
  await session.receive(JSON.stringify(initialize));
  const init=JSON.parse(session.project(JSON.stringify({id:901,result:{capabilities:{extensions:{'opencraft/thread-directory-merkle':{version:1}}}}}))!);
  assert.equal(init.result.capabilities.extensions['opencraft/thread-directory-merkle'],undefined);
  await session.receive(JSON.stringify({id:902,method:'thread/list',params:{}}));
  const reply=JSON.parse(session.project(JSON.stringify({id:902,result:{data:[],nextCursor:null,catalogMerkle:{version:1,mode:'compare',root:'a'.repeat(64),count:999,projected:true,leaves:['b'.repeat(64)]}}}))!);
  assert.deepEqual(reply.result.catalogMerkle,{version:1,mode:'fallback',root:'0'.repeat(64),count:0});
  session.close();
});
