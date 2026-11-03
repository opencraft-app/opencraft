import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionReadCache, withPermissionWrite as write } from '../../packages/access-control/src/permission-read-cache.js';
import { openServerDatabase } from '../../packages/storage-node/src/server/index.js';
import { ActorStore } from '../../packages/access-control/src/actors.js';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index.js';
function fixture(db: DatabaseSync) {
  db.exec("CREATE TABLE policy(id TEXT PRIMARY KEY,enabled INTEGER); INSERT INTO policy VALUES('a',1)");
  const cache=new PermissionReadCache(function*(){for(const row of db.prepare('SELECT * FROM policy').iterate())yield [String(row.id),row.enabled] as const;});
  return {cache,get:(id='a')=>cache.get(id,()=>db.prepare('SELECT enabled FROM policy WHERE id=?').get(id)?.enabled)};
}
test('permission hits and misses stay in memory without a database read-through',()=>{
 const db=new DatabaseSync(':memory:');try{
  const f=fixture(db);db.prepare=(()=>{throw Error('hot-path SQL');}) as typeof db.prepare;
  assert.equal(f.get(),1);assert.equal(f.get('missing'),undefined);assert.equal(f.get(),1);
 }finally{db.close();}
});
test('owner mutations publish committed state and rollback before returning; asynchronous readers see the new memory generation',async()=>{
 const db=new DatabaseSync(':memory:');try{
  const f=fixture(db);write(()=>db.exec("UPDATE policy SET enabled=0 WHERE id='a'"),f.cache);assert.equal(f.get(),0);
  assert.throws(()=>write(()=>{db.exec("BEGIN; UPDATE policy SET enabled=1 WHERE id='a'");assert.equal(f.get(),1);db.exec('ROLLBACK');throw Error('rollback');},f.cache),/rollback/);
  assert.equal(f.get(),0);await Promise.resolve();write(()=>db.exec("UPDATE policy SET enabled=1 WHERE id='a'"),f.cache);assert.equal(f.get(),1);
  f.cache.close();assert.throws(()=>f.get(),/closed/);
 }finally{db.close();}
});
test('failed projection refresh and memory-budget overflow reject reads instead of querying the database',()=>{
 assert.throws(()=>new PermissionReadCache(()=>[['a',1],['b',2]],{entries:1}),/budget/);
 assert.throws(()=>new PermissionReadCache(()=>[['a','oversized']],{entries:100,bytes:2}),/budget/);
 const db=new DatabaseSync(':memory:');try{
  const f=fixture(db);assert.throws(()=>write(()=>db.exec('DROP TABLE policy'),f.cache),/no such table/);
  assert.throws(()=>f.get(),/unavailable/);
 }finally{db.close();}
});
test('Actor, membership, credential, grant delivery checks execute zero SQL and owner revocation remains immediate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oc-permission-memory-')),source=await openServerDatabase(dir),db=source.database;
 const actors=new ActorStore(source),members=new MembershipStore(source);
 const principal={provider:'fixture',subject:'human',displayName:'Human',expiresAt:Date.now()+60000},human=actors.resolveHuman(principal)!;
 members.set(principal,'member',true,'fixture');members.setActor(human.actorId,'member',true,'fixture');
 const access=new InstanceAccess(members,[],actors,['fixture']);
 const session=actors.createSession('Session','fixture'),credential=actors.issueCredential(session.id,Date.now()+60000,'fixture'),proof=actors.authenticateSession(credential.token)!;
 actors.setGrant(session.id,human.actorId,'test.read',true,'fixture');
 const prepare=db.prepare,exec=db.exec;
 try{
  db.prepare=(()=>{throw Error('hot-path prepare');}) as typeof db.prepare;
  db.exec=(()=>{throw Error('hot-path exec');}) as typeof db.exec;
  for(let i=0;i<100;i++){
   assert.equal(access.admitsActor(human.actorId),true);assert.equal(access.role(principal),'member');assert.equal(actors.isCurrent(human),true);
   assert.equal(actors.resolveHuman(principal)?.actorId,human.actorId);assert.equal(actors.findHuman(principal)?.id,human.actorId);assert.equal(actors.bindings(human.actorId)[0]?.subject,'human');
   assert.equal(actors.isCurrent(proof),true);assert.equal(actors.can(proof,human.actorId,'test.read'),true);
  }
  assert.equal(actors.get('missing'),null);assert.equal(members.actorMembership('missing'),null);
  db.prepare=prepare;db.exec=exec;
  members.setActor(human.actorId,'member',false,'fixture');assert.equal(access.admitsActor(human.actorId),false);
  members.setActor(human.actorId,'member',true,'fixture');assert.equal(access.admitsActor(human.actorId),true);
  actors.revokeCredential(credential.credentialId,'fixture');assert.equal(actors.isCurrent(proof),false);
  actors.setEnabled(human.actorId,false,'fixture');assert.equal(access.admitsActor(human.actorId),false);
  actors.setEnabled(human.actorId,true,'fixture');assert.equal(actors.isCurrent(human),false);
  principal.expiresAt=0;assert.equal(access.role(principal),null);
  actors.close();assert.throws(()=>actors.get(human.actorId),/closed/);
 }finally{db.prepare=prepare;db.exec=exec;members.close();actors.close();await source.close();await rm(dir,{recursive:true,force:true});}
});
