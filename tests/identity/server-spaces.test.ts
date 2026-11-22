import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ActorStore } from '@opencraft/access-control/actors';
import { openServerDatabase, SERVER_MIGRATIONS } from '@opencraft/storage-node/server';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { ServerSpacesLedger } from '../../packages/access-control/src/server-spaces-ledger.js';
import { ServerSpacesRuntime } from '../../packages/access-control/src/server-spaces-runtime.js';
import { ThreadAccessStore } from '../../packages/access-control/src/thread-access.js';
import { ServerSpacesSession } from '../../packages/access-control/src/server-spaces-session.js';
import type { ServerSpaceDirectory } from '@opencraft/appserver-protocol/server-spaces';

async function fixture(t:test.TestContext) {
  const path=mkdtempSync(join(tmpdir(),'opencraft-spaces-'));
  const owner=await openServerDatabase(path),actors=new ActorStore(owner);
  const human=(name:string)=>actors.resolveHuman({provider:'test',subject:name,displayName:name,expiresAt:Date.now()+7*24*3600_000})!;
  const alice=human('Alice'),bob=human('Bob'),eve=human('Eve');
  t.after(async()=>{actors.close();await owner.close();rmSync(path,{recursive:true,force:true});});
  return {path,owner,actors,alice,bob,eve};
}

test('spaces keep memberships, invitations, private policy and engine namespaces independent',async t=>{
  const f=await fixture(t);let now=Date.now();const ledger=new ServerSpacesLedger(f.owner.database,()=>now);
  ledger.bootstrap(f.alice.actorId);
  const create=ledger.command(f.alice,{action:'create',name:'Project'}) as {spaceId:string};
  assert.equal(ledger.directory(f.alice).spaces.length,2);
  assert.equal(ledger.directory(f.bob).spaces.length,0);
  assert.throws(()=>ledger.command(f.bob,{action:'members',spaceId:create.spaceId}));
  assert.throws(()=>ledger.command(f.bob,{action:'invite',spaceId:create.spaceId}));
  const invitation=ledger.command(f.alice,{action:'invite',spaceId:create.spaceId}) as {code:string};
  const stored=JSON.stringify(f.owner.database.prepare('SELECT * FROM collaboration_space_invitations').all());
  assert(!stored.includes(invitation.code),'only invitation digest is stored');
  ledger.command(f.alice,{action:'join',code:invitation.code}); // Owner preview cannot consume someone else's invitation.
  ledger.command(f.bob,{action:'join',code:invitation.code});
  assert.equal(ledger.directory(f.bob).spaces[0].id,create.spaceId);
  assert.throws(()=>ledger.command(f.eve,{action:'join',code:invitation.code}));
  ledger.command(f.bob,{action:'join',code:invitation.code}); // Lost reply is idempotent for the same human.
  assert.equal(ledger.members(f.bob,create.spaceId).length,2);
  ledger.assign(f.alice,'codex','same-thread',create.spaceId);
  ledger.assign(f.alice,'cursor','same-thread','myself');
  const runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite')});await runtime.ready;t.after(()=>runtime.close());
  assert(runtime.allows(f.bob.actorId,'codex','same-thread'));
  assert(!runtime.allows(f.bob.actorId,'cursor','same-thread'));
  assert(!runtime.allows(f.bob.actorId,'codex','historical-thread'));
  const policy=new ThreadAccessStore(f.owner,f.actors,{spaces:runtime});t.after(()=>policy.close());
  policy.created('codex','same-thread',f.alice);
  assert(policy.allows('codex','same-thread',f.bob));
  policy.set('codex','same-thread','private',1,f.alice);
  assert(!policy.allows('codex','same-thread',f.bob),'space membership cannot bypass private policy');
  policy.set('codex','same-thread','shared',2,f.alice);
  await runtime.command(f.alice,{action:'remove',spaceId:create.spaceId,actorId:f.bob.actorId});
  assert(!policy.allows('codex','same-thread',f.bob),'removal takes effect before reply');
  assert.throws(()=>ledger.command(f.alice,{action:'remove',spaceId:create.spaceId,actorId:f.alice.actorId}));
  const expired=ledger.command(f.alice,{action:'invite',spaceId:create.spaceId}) as {code:string};now+=24*3600_000+1;
  assert.throws(()=>ledger.command(f.eve,{action:'join',code:expired.code}),(error:unknown)=>(error as {reason:string}).reason==='invitation');
});

test('Worker drains writes, restores assignments, and does not block network timers behind a SQLite lock',async t=>{
  const f=await fixture(t);
  const runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),ownerActorId:f.alice.actorId});await runtime.ready;
  const project=await runtime.command(f.alice,{action:'create',name:'Persistent'});
  await runtime.assign(f.alice,'codex','persisted',project.spaceId);
  await runtime.inherit({serverId:'codex',threadId:'persisted'},{serverId:'cursor',threadId:'child'});
  assert.equal(runtime.spaceFor('cursor','child'),project.spaceId);
  const lock=new DatabaseSync(join(f.path,'opencraft-server.sqlite'));lock.exec('BEGIN IMMEDIATE');
  let ticked=false;const timer=new Promise<void>(resolve=>setTimeout(()=>{ticked=true;resolve();},20));
  const write=runtime.command(f.alice,{action:'create',name:'After lock'});
  await timer;assert(ticked);lock.exec('ROLLBACK');lock.close();await write;
  await runtime.close();
  const restored=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite')});await restored.ready;
  assert.equal(restored.spaceFor('codex','persisted'),project.spaceId);
  assert.equal(restored.directory(f.alice).spaces.length,3);
  await restored.close();
});

test('creation commits its captured space before a Native response can be published',async t=>{
  const f=await fixture(t);const runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),ownerActorId:f.alice.actorId});await runtime.ready;t.after(()=>runtime.close());
  const p=await runtime.command(f.alice,{action:'create',name:'New space'});
  const frames:string[]=[];
  const session=new ServerSpacesSession(runtime,f.alice,()=> 'codex',frame=>frames.push(frame),{receive:()=>false,project:frame=>frame,close(){}},(serverId,threadId)=>runtime.allows(f.alice.actorId,serverId,threadId));t.after(()=>session.close());
  await session.receive(JSON.stringify({id:1,method:'opencraft/server-spaces',params:{action:'select',spaceId:p.spaceId}}));
  await session.receive(JSON.stringify({id:0,method:'opencraft/server-spaces',params:{action:'select',spaceId:'myself'}}));
  const creation=JSON.stringify({id:2,method:'thread/start',params:{collaborationSpaceId:p.spaceId}});
  await session.receive(creation);
  assert.equal(JSON.parse(session.rewrite(creation)).params.collaborationSpaceId,undefined);
  await session.receive(JSON.stringify({id:3,method:'opencraft/server-spaces',params:{action:'select',spaceId:'myself'}}));
  await session.prepare(JSON.stringify({id:2,result:{thread:{id:'new'}}}));
  assert.equal(runtime.spaceFor('codex','new'),p.spaceId);
  assert(frames.some(f=>JSON.parse(f).id===1));
});

test('previous Server schema upgrades without losing data and rejects modified migration checksums',async t=>{
  const root=mkdtempSync(join(tmpdir(),'opencraft-space-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'database.sqlite');
  const previous=openManagedDatabase({path,migrations:SERVER_MIGRATIONS.slice(0,-1),legacyPolicy:'reject'});
  previous.database.prepare("INSERT INTO actor_authority VALUES(1,'migration-proof')").run();previous.database.close();
  const updated=openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'});
  assert.equal(updated.database.prepare('SELECT id FROM actor_authority').get()?.id,'migration-proof');
  assert.equal(updated.database.prepare("SELECT COUNT(*) AS n FROM collaboration_spaces").get()?.n,0);updated.database.close();
  const tamper=new DatabaseSync(path);tamper.prepare("UPDATE schema_migrations SET checksum='wrong' WHERE version=?").run(SERVER_MIGRATIONS.length);tamper.close();
  assert.throws(()=>openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'}));
});

test('upgrade keeps existing spaces and their members, with contact closed',async t=>{
  const root=mkdtempSync(join(tmpdir(),'opencraft-space-contact-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'database.sqlite');
  const before=SERVER_MIGRATIONS.findIndex(m=>m.name==='0020_crew');assert(before>0);
  const previous=openManagedDatabase({path,migrations:SERVER_MIGRATIONS.slice(0,before),legacyPolicy:'reject'});
  assert.equal(previous.database.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('collaboration_spaces') WHERE name='open_contact'").get()?.n,0);
  previous.database.prepare("INSERT INTO collaboration_spaces VALUES('legacy','Legacy','owner-1',1)").run();
  previous.database.prepare("INSERT INTO collaboration_space_members VALUES('legacy','owner-1','owner',1)").run();
  previous.database.close();
  const updated=openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'});t.after(()=>updated.database.close());
  assert.deepEqual({...updated.database.prepare("SELECT id,name,owner_actor_id,created_at,open_contact FROM collaboration_spaces").get()},
    {id:'legacy',name:'Legacy',owner_actor_id:'owner-1',created_at:1,open_contact:0});
  assert.equal(updated.database.prepare("SELECT role FROM collaboration_space_members WHERE space_id='legacy'").get()?.role,'owner');
  assert.equal(updated.database.prepare('SELECT COUNT(*) AS n FROM crew_work').get()?.n,0,'crew work starts empty after upgrade');
  assert.equal(updated.database.prepare('SELECT COUNT(*) AS n FROM crew_messages').get()?.n,0,'crew replies start empty after upgrade');
});

test('new spaces open contact, the default space does not, and only the owner switches it',async t=>{
  const f=await fixture(t);const ledger=new ServerSpacesLedger(f.owner.database);
  ledger.bootstrap(f.alice.actorId,[f.bob.actorId]);
  const created=ledger.command(f.alice,{action:'create',name:'Team'}) as {spaceId:string};
  const open=(context:typeof f.alice,id:string)=>ledger.directory(context).spaces.find(s=>s.id===id)?.openContact;
  assert.equal(open(f.alice,'myself'),false);
  assert.equal(open(f.alice,created.spaceId),true);
  assert.throws(()=>ledger.command(f.bob,{action:'contact',spaceId:'myself',open:true}),'a member cannot switch contact');
  assert.throws(()=>ledger.command(f.alice,{action:'contact',spaceId:created.spaceId,open:'yes'} as never));
  ledger.command(f.alice,{action:'contact',spaceId:created.spaceId,open:false});
  assert.equal(open(f.alice,created.spaceId),false);
  const runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite')});await runtime.ready;t.after(()=>runtime.close());
  await runtime.command(f.alice,{action:'contact',spaceId:created.spaceId,open:true});
  assert.equal(runtime.directory(f.alice).spaces.find(s=>s.id===created.spaceId)?.openContact,true,'the committed switch is published');
});

test('the owner adds a Bot as a peer member of exactly one space',async t=>{
  const f=await fixture(t);const ledger=new ServerSpacesLedger(f.owner.database);
  ledger.bootstrap(f.alice.actorId,[f.bob.actorId]);
  const team=ledger.command(f.alice,{action:'create',name:'Team'}) as {spaceId:string};
  const other=ledger.command(f.alice,{action:'create',name:'Other'}) as {spaceId:string};
  const bot=f.actors.createSession('Alan',f.alice.actorId);
  assert.throws(()=>ledger.command(f.bob,{action:'addBot',spaceId:'myself',actorId:bot.id}),'a member cannot add Bots');
  assert.throws(()=>ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:f.bob.actorId}),'humans join by invitation, not addBot');
  assert.throws(()=>ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:'missing'}));
  const result=ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:bot.id}) as {members:{actorId:string;kind:string;role:string}[]};
  assert.deepEqual(result.members.map(m=>[m.kind,m.role]),[['human','owner'],['session','member']]);
  ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:bot.id}); // repeating is harmless
  assert.throws(()=>ledger.command(f.alice,{action:'addBot',spaceId:other.spaceId,actorId:bot.id}),'one space per Bot');
  ledger.command(f.alice,{action:'remove',spaceId:team.spaceId,actorId:bot.id});
  ledger.command(f.alice,{action:'addBot',spaceId:other.spaceId,actorId:bot.id});
  assert.equal(ledger.members(f.alice,other.spaceId).find(m=>m.actorId===bot.id)?.kind,'session');
  const bobs=f.actors.createSession('Bobs',f.bob.actorId);
  assert.throws(()=>ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:bobs.id}),'someone else\'s Bot is not the owner\'s to place');
});

test('the owner sees their own additional assistants that are not yet in a space',async t=>{
  const f=await fixture(t);const ledger=new ServerSpacesLedger(f.owner.database);
  ledger.bootstrap(f.alice.actorId,[f.bob.actorId]);
  const team=ledger.command(f.alice,{action:'create',name:'Team'}) as {spaceId:string};
  const assistant=(name:string,owner:{actorId:string},isDefault:0|1)=>{
    const actor=f.actors.createSession(name,owner.actorId),human=f.actors.get(owner.actorId)!;
    f.owner.database.prepare(`INSERT INTO personal_assistants(bot_id,actor_id,owner_human_id,owner_generation,assignment_id,epoch,state,created_at,is_default,paused)
      VALUES(?,?,?,?,?,'1','claimed',?,?,0)`).run('bot-'+name,actor.id,human.id,human.generation,'assignment-'+name,Date.now(),isDefault);
    return actor;
  };
  const alan=assistant('Alan',f.alice,0);assistant('Butler',f.alice,1);assistant('Bobby',f.bob,0);
  const list=()=>(ledger.command(f.alice,{action:'bots',spaceId:team.spaceId}) as {bots:{actorId:string;displayName:string}[]}).bots;
  assert.deepEqual(list(),[{actorId:alan.id,displayName:'Alan'}],'not the default assistant, not someone else\'s');
  assert.throws(()=>ledger.command(f.bob,{action:'bots',spaceId:'myself'}),'owners only');
  ledger.command(f.alice,{action:'addBot',spaceId:team.spaceId,actorId:alan.id});
  assert.deepEqual(list(),[],'a placed Bot is no longer offered');
});

test('Native delivery filters spaces and revokes an already observed conversation; unknown Threads stay closed',async t=>{
  const f=await fixture(t),runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),ownerActorId:f.alice.actorId});await runtime.ready;t.after(()=>runtime.close());
  const space=await runtime.command(f.alice,{action:'create',name:'Shared'});
  const invite=await runtime.command(f.alice,{action:'invite',spaceId:space.spaceId});
  await runtime.command(f.bob,{action:'join',code:invite.code});
  await runtime.assign(f.alice,'codex','team-thread',space.spaceId);
  const policy=new ThreadAccessStore(f.owner,f.actors,{spaces:runtime});t.after(()=>policy.close());
  const aliceFrames:string[]=[],bobFrames:string[]=[];
  const {ThreadAccessSession}=await import('../../packages/access-control/src/thread-access.js');
  const aliceBase=new ThreadAccessSession(policy,()=> 'codex',f.alice,frame=>aliceFrames.push(frame));
  const alice=new ServerSpacesSession(runtime,f.alice,()=> 'codex',frame=>aliceFrames.push(frame),aliceBase,(serverId,threadId)=>policy.allows(serverId,threadId,f.alice));t.after(()=>alice.close());
  const bobBase=new ThreadAccessSession(policy,()=> 'codex',f.bob,frame=>bobFrames.push(frame));
  const bob=new ServerSpacesSession(runtime,f.bob,()=> 'codex',frame=>bobFrames.push(frame),bobBase,(serverId,threadId)=>policy.allows(serverId,threadId,f.bob));t.after(()=>bob.close());
  const rows=[{id:'old-thread',createdAt:Math.floor(Date.now()/1000)-100},{id:'new-unknown',createdAt:Math.floor(Date.now()/1000)+1},{id:'team-thread',createdAt:Math.floor(Date.now()/1000)}];
  await alice.receive(JSON.stringify({id:10,method:'thread/list',params:{}}));
  const frame=JSON.stringify({id:10,result:{data:rows}});await alice.prepare(frame);
  assert.deepEqual(JSON.parse(alice.project(frame)!).result.data.map((r:{id:string})=>r.id),['old-thread','team-thread']);
  await bob.receive(JSON.stringify({id:11,method:'thread/list',params:{}}));
  const bobList=JSON.stringify({id:11,result:{data:rows}});await bob.prepare(bobList);
  assert.deepEqual(JSON.parse(bob.project(bobList)!).result.data.map((r:{id:string})=>r.id),['team-thread']);
  assert(await bob.receive(JSON.stringify({id:12,method:'turn/start',params:{threadId:'old-thread'}})));
  assert(bobFrames.some(frame=>JSON.parse(frame).id===12&&JSON.parse(frame).error));
  const usage = (id:number) => JSON.stringify({id,method:'opencraft/token-usage/query',params:{threadId:'team-thread'}});
  assert.equal(await bob.receive(usage(40)),false,'assigned space members can query conversation usage');
  policy.created('codex','team-thread',f.alice);
  policy.set('codex','team-thread','private',1,f.alice);
  assert.equal(await bob.receive(usage(41)),true,'private conversation usage remains protected');
  await bob.receive(JSON.stringify({id:20,method:'opencraft/server-spaces',params:{action:'list'}}));
  const directory=JSON.parse(bobFrames.find(frame=>JSON.parse(frame).id===20)!).result as ServerSpaceDirectory;
  assert(!directory.assignments.some(row=>row.threadId==='team-thread'),'space directory must not reveal a private Thread ID');
  policy.set('codex','team-thread','shared',2,f.alice);
  await bob.receive(JSON.stringify({id:21,method:'thread/list',params:{}}));
  const observed=JSON.stringify({id:21,result:{data:rows}});await bob.prepare(observed);bob.project(observed);
  await runtime.command(f.alice,{action:'remove',spaceId:space.spaceId,actorId:f.bob.actorId});
  assert(bobFrames.some(frame=>JSON.parse(frame).method==='opencraft/thread-access/revoked'));
  assert.equal(await bob.receive(usage(42)),true,'removed members cannot query conversation usage');
  assert.equal(bob.project(JSON.stringify({method:'thread/updated',params:{threadId:'team-thread'}})),null);
});

test('existing instance members and persisted policies migrate; direct historical links restore without a catalog first',async t=>{
  const f=await fixture(t);
  const {MembershipStore}=await import('@opencraft/access-control');
  const members=new MembershipStore(f.owner);t.after(()=>members.close());
  members.setActor(f.alice.actorId,'admin',true,'fixture');members.setActor(f.bob.actorId,'member',true,'fixture');
  const policy=new ThreadAccessStore(f.owner,f.actors);t.after(()=>policy.close());
  policy.created('codex','persisted-policy',f.alice);
  const runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),bootstrapInstance:true});await runtime.ready;t.after(()=>runtime.close());
  assert(runtime.hasAssignment('codex','persisted-policy'));
  assert.equal(runtime.directory(f.alice).spaces[0].memberCount,2);
  assert.equal(runtime.directory(f.eve).spaces.length,0);
  const scoped=new ThreadAccessStore(f.owner,f.actors,{spaces:runtime});t.after(()=>scoped.close());
  const frames:string[]=[];
  const {ThreadAccessSession}=await import('../../packages/access-control/src/thread-access.js');
  const base=new ThreadAccessSession(scoped,()=> 'codex',f.bob,frame=>frames.push(frame));
  const session=new ServerSpacesSession(runtime,f.bob,()=> 'codex',frame=>frames.push(frame),base,
    (serverId,threadId)=>scoped.allows(serverId,threadId,f.bob),()=>{},async id=>({thread:{id,createdAt:Math.floor(Date.now()/1000)+(id==='recent'?1:-100)}}));t.after(()=>session.close());
  assert.equal(await session.receive(JSON.stringify({id:1,method:'thread/read',params:{threadId:'legacy-link'}})),false);
  assert(runtime.hasAssignment('codex','legacy-link'));
  assert.equal(await session.receive(JSON.stringify({id:2,method:'thread/read',params:{threadId:'recent'}})),true);
  assert(!runtime.hasAssignment('codex','recent'));
});

test('handoff inherits the source space instead of the selected destination and strips Hub-only fields',async t=>{
  const f=await fixture(t),runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),ownerActorId:f.alice.actorId});
  await runtime.ready;t.after(()=>runtime.close());
  const team=await runtime.command(f.alice,{action:'create',name:'Team'});
  await runtime.assign(f.alice,'pi','source',team.spaceId);
  const policy=new ThreadAccessStore(f.owner,f.actors,{spaces:runtime});t.after(()=>policy.close());
  policy.created('pi','source',f.alice);policy.set('pi','source','private',1,f.alice);
  const {ThreadAccessSession}=await import('../../packages/access-control/src/thread-access');
  const server=(id:string)=>id==='source'?'pi':'codex';
  const base=new ThreadAccessSession(policy,server,f.alice,()=>{});
  const session=new ServerSpacesSession(runtime,f.alice,server,()=>{},base,(s,id)=>policy.allows(s,id,f.alice));t.after(()=>session.close());
  const request=JSON.stringify({id:1,method:'thread/start',params:{collaborationSpaceId:'myself',agentId:'codex',handoffSource:{threadId:'source'}}});
  assert.equal(await session.receive(request),false);
  assert.deepEqual(JSON.parse(session.rewrite(request)).params,{agentId:'codex'});
  const response=JSON.stringify({id:1,result:{thread:{id:'destination'}}});
  await session.prepare(response);assert.ok(session.project(response));
  assert.equal(runtime.spaceFor('codex','destination'),team.spaceId);
  assert.equal(policy.read('codex','destination').accessMode,'private');
  assert.equal(runtime.allows(f.bob.actorId,'codex','destination'),false);
});


test('historical reads publish a space change once and do not create a refresh loop',async t=>{
  const f=await fixture(t),runtime=new ServerSpacesRuntime({path:join(f.path,'opencraft-server.sqlite'),ownerActorId:f.alice.actorId});
  await runtime.ready;t.after(()=>runtime.close());
  let changes=0;const unsubscribe=runtime.subscribe(()=>changes++);t.after(unsubscribe);
  const old=[{id:'old',createdAt:Math.floor(Date.now()/1000)-100}];
  await runtime.adoptLegacy(f.alice,'pi',old);
  assert(runtime.hasAssignment('pi','old'));assert.equal(changes,1);
  await runtime.adoptLegacy(f.alice,'pi',old);
  await runtime.adoptLegacy(f.alice,'pi',[{id:'recent',createdAt:Math.floor(Date.now()/1000)+100}]);
  assert.equal(changes,1);assert(!runtime.hasAssignment('pi','recent'));
});
