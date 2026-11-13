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
  policy.created('codex','team-thread',f.alice);
  policy.set('codex','team-thread','private',1,f.alice);
  await bob.receive(JSON.stringify({id:20,method:'opencraft/server-spaces',params:{action:'list'}}));
  const directory=JSON.parse(bobFrames.find(frame=>JSON.parse(frame).id===20)!).result as ServerSpaceDirectory;
  assert(!directory.assignments.some(row=>row.threadId==='team-thread'),'space directory must not reveal a private Thread ID');
  policy.set('codex','team-thread','shared',2,f.alice);
  await bob.receive(JSON.stringify({id:21,method:'thread/list',params:{}}));
  const observed=JSON.stringify({id:21,result:{data:rows}});await bob.prepare(observed);bob.project(observed);
  await runtime.command(f.alice,{action:'remove',spaceId:space.spaceId,actorId:f.bob.actorId});
  assert(bobFrames.some(frame=>JSON.parse(frame).method==='opencraft/thread-access/revoked'));
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
