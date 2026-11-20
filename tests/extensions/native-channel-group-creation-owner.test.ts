import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '@opencraft/access-control/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'group-created-owner-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 const human=actors.resolveHuman({provider:'local',subject:'fixture',displayName:'Fixture',expiresAt:Date.now()+60000})!;
 storage.database.exec('CREATE TABLE fixture_group_intents(channel_id TEXT PRIMARY KEY, title TEXT) STRICT');return{db:storage.database,actors,service,human};
}
test('trusted callback observes normalized native state inside creation and runs only once',async t=>{
 const f=await fixture(t);let calls=0;
 const group=f.service.createChannelGroup(f.human,'  Launch  ',[],'same',(id,input)=>{
  calls++;assert.equal(f.db.prepare('SELECT title FROM actor_channels WHERE id=?').get(id)!.title,'Launch');assert.deepEqual(input,{title:'Launch',members:[]});f.db.prepare('INSERT INTO fixture_group_intents VALUES(?,?)').run(id,input.title);
 });
 assert.equal(calls,1);const retried=f.service.createChannelGroup(f.human,'Launch',[],'same',()=>{throw Error('retry must not enqueue again');});assert.equal(retried.id,group.id);assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_group_intents').get()!.n,1);
 assert.throws(()=>f.service.createChannelGroup(f.human,'Changed',[],'same',()=>calls++),/idempotency_conflict/);assert.equal(calls,1);
});
test('callback failure atomically rolls back both native group and installation intent',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT count(*) AS n FROM actor_channels').get()!.n;
 assert.throws(()=>f.service.createChannelGroup(f.human,'Rollback',[],'rollback',(id,input)=>{f.db.prepare('INSERT INTO fixture_group_intents VALUES(?,?)').run(id,input.title);throw Error('fixture failure');}),/fixture failure/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channels').get()!.n,before);assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_group_intents').get()!.n,0);let calls=0;f.service.createChannelGroup(f.human,'Rollback',[],'rollback',()=>calls++);assert.equal(calls,1);
});
test('authority and member validation remain with the native owner before callback',async t=>{
 const f=await fixture(t);let calls=0;assert.throws(()=>f.service.createChannelGroup(f.human,'Too many',Array(64).fill(f.human.actorId),'invalid',()=>calls++),/invalid_input/);
 const session=f.actors.createSession('Fixture agent',f.human.actorId);const credential=f.actors.issueCredential(session.id,Date.now()+60000,f.human.actorId),context=f.actors.authenticateSession(credential.token)!;
 assert.throws(()=>f.service.createChannelGroup(context,'Denied',[],'denied',()=>calls++),/channel_denied/);assert.equal(calls,0);
});
test('public RPC cannot select an installation callback or undeclared creation option',async t=>{
 const f=await fixture(t);
 for(const extra of [{installationChoice:true},{onCreated:'chosen-by-request'}])await assert.rejects(f.service.communicate(f.human,'opencraft/channels/group/create',{title:'Denied',memberActorIds:[],clientRequestId:'rpc',...extra}),/invalid_input/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channels').get()!.n,0);
});
