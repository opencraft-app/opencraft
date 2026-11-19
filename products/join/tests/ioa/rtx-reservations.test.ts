import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { ActorStore } from '../../../../packages/access-control/src/actors';
import { Collaboration } from '../../../../packages/access-control/src/collaboration';
import { InstanceAccess, MembershipStore } from '../../../../packages/access-control/src/index';
import { rtxReservationClaim, createRtxLoginPreparation, synchronizeRtxMembers } from '../../plugins/tencentoa/src/rtx-directory.mjs';

const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const snapshot={externalId:'room',memberIds:['T10001A']};
const proof=(subject='123',userId='T10001A')=>({provider:'tencentoa',subject,displayName:'Display only',aliases:['login:alice'],
 attributes:{loginName:'alice',wecomCorpId:'wxfixture',wecomUserId:userId,wecomVerifiedUntil:String(Date.now()+50000)},expiresAt:Date.now()+3600000});
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'ioa-reservation-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),members=new MembershipStore(storage);
 const service=new Collaboration(storage,actors);actors.registerHumanReservationResolver(rtxReservationClaim);
 let registrations=0;actors.onHumanRegistered(()=>registrations++);
 t.after(async()=>{await service.close();members.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 const reserve=async(userId='T10001A')=>service.synchronizeChannels({method:'reserveHuman',params:{reservation:{binding:{provider:'wecom.wxfixture',subject:userId},loginProvider:'tencentoa',alias:'alice'}}});
 return{storage,actors,members,service,reserve,registrations:()=>registrations};
}
test('provider directory precreates a disabled Human; actual admitted login atomically claims the same Actor',async t=>{
 const f=await fixture(t);
 await synchronizeRtxMembers(f.service,source,snapshot,{source,members:[{userId:'T10001A',rtx:'alice',subject:null,expiresAt:Date.now()+50000}]});
 const reserved=await f.reserve();assert.equal(reserved.enabled,false);
 assert.equal(f.actors.get(reserved.id)?.enabled,false);
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T10001A'}),null);
 assert.deepEqual(f.actors.bindings(reserved.id),[]);assert.equal(f.registrations(),0);
 const access=new InstanceAccess(f.members,[{authenticate:()=>proof()}],f.actors,['tencentoa']);
 assert.equal(access.admitsActor(reserved.id),false);
 assert.equal(access.admissionStatus({headers:{}}),204);
 assert.equal(f.actors.findHuman({provider:'tencentoa',subject:'123'})?.id,reserved.id);
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T10001A'})?.id,reserved.id);
 assert.equal(f.actors.resolveHuman(proof())?.actorId,reserved.id);
 assert.equal(f.actors.list().length,1);assert.equal(f.registrations(),1,'registration occurs only on verified first login');
 assert.equal(f.storage.database.prepare('SELECT count(*) AS n FROM actor_credentials').get()!.n,0);
 assert.equal(f.storage.database.prepare('SELECT count(*) AS n FROM personal_assistants').get()!.n,0);
});
test('reservation cannot bypass admission, missing directory proof, revocation or another employee claim',async t=>{
 const f=await fixture(t),reserved=await f.reserve();
 const explicit=new InstanceAccess(f.members,[{authenticate:()=>proof()}],f.actors);
 assert.equal(explicit.admissionStatus({headers:{}}),403);assert.equal(f.actors.get(reserved.id)?.enabled,false);
 assert.throws(()=>f.actors.resolveHuman({...proof(),attributes:{loginName:'alice'}}),/directory evidence/);
 assert.throws(()=>f.actors.resolveHuman(proof('123','Tchanged')),/directory evidence/);
 assert.equal(f.actors.list().length,1);
 f.actors.setEnabled(reserved.id,false,'administrator');
 assert.throws(()=>f.actors.resolveHuman(proof()),/retired/);
 assert.equal(f.actors.get(reserved.id)?.enabled,false);assert.equal(f.registrations(),0);
});
test('rehired RTX must claim a new provider userid and cannot inherit the old Actor',async t=>{
 const f=await fixture(t),old=await f.reserve();
 assert.equal(f.actors.resolveHuman(proof())?.actorId,old.id);
 assert.throws(()=>f.actors.resolveHuman(proof('456')),/retired/);
 const fresh=await f.reserve('T20002A');
 const context=f.actors.resolveHuman(proof('456','T20002A'))!;
 assert.equal(context.actorId,fresh.id);assert.notEqual(context.actorId,old.id);
 assert.equal(f.actors.findHuman({provider:'tencentoa',subject:'123'})?.id,old.id);
});
test('concurrent Worker reservations are idempotent and survive owner reconstruction',async t=>{
 const f=await fixture(t),rows=await Promise.all(Array.from({length:8},()=>f.reserve()));
 assert.equal(new Set(rows.map(r=>r.id)).size,1);assert.equal(f.registrations(),0);
 const restored=new ActorStore(f.storage);restored.registerHumanReservationResolver(rtxReservationClaim);
 try{assert.equal(restored.resolveHuman(proof())?.actorId,rows[0].id);}finally{restored.close();}
});
test('login preparation replaces stale hints and requires reciprocal directory evidence',async()=>{
 const prepare=createRtxLoginPreparation(()=>async()=>({corpId:'wxfixture',userId:'T20002A',rtx:'alice'}));
 const current=await prepare(proof());assert.equal(current.subject,'123');assert.equal(current.attributes.wecomUserId,'T20002A');
 const failed=await createRtxLoginPreparation(()=>async()=>{throw Error('unavailable');})(proof());
 assert.equal(failed.attributes.wecomUserId,undefined);assert.equal(rtxReservationClaim(failed)?.binding,null);
});

test('an existing IOA account retires only an untouched dormant reservation when its current userid is linked',async t=>{
 const f=await fixture(t),p=proof(),existing=f.actors.resolveHuman(p)!;
 const pending=await f.reserve();assert.notEqual(pending.id,existing.actorId);
 await synchronizeRtxMembers(f.service,source,snapshot,{source,members:[{userId:'T10001A',rtx:'alice',subject:'123',expiresAt:Date.now()+50000}]});
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T10001A'})?.id,existing.actorId);
 assert.equal(f.actors.get(pending.id),null);assert.equal(f.actors.list().length,1);
 assert.equal(f.actors.resolveHuman(p)?.actorId,existing.actorId);
});

test('reservation migration upgrades the previous server schema without changing existing identities',async t=>{
 const { openManagedDatabase }=await import('@opencraft/sqlite-node');
 const { SERVER_MIGRATIONS }=await import('@opencraft/storage-node/server');
 const dir=await mkdtemp(join(tmpdir(),'ioa-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const old=openManagedDatabase({path:join(dir,'opencraft-server.sqlite'),migrations:SERVER_MIGRATIONS.slice(0,-1),legacyPolicy:'reject'});
 const actors=new ActorStore(old);const context=actors.resolveHuman(proof())!;actors.close();old.database.close();
 const upgraded=await openServerDatabase(dir),next=new ActorStore(upgraded);
 try{assert.equal(next.findHuman({provider:'tencentoa',subject:'123'})?.id,context.actorId);assert.equal(next.list().length,1);
  assert.equal(upgraded.database.prepare('SELECT count(*) AS n FROM actor_human_reservations').get()!.n,0);
 }finally{next.close();await upgraded.close();}
});

test('reservation schema matches the complete Join migration snapshot',async()=>{
 const { readFile }=await import('node:fs/promises');
 const { generateSQLiteDrizzleJson, generateSQLiteMigration }=await import('drizzle-kit/api');
 const core=await import('../../../../packages/storage-node/src/server/schema');
 const joinSchema=await import('../../plugins/wecom/assistant-schema');
 const meta=new URL('../../../../packages/storage-node/src/server/migrations/meta/',import.meta.url);
 const journal=JSON.parse(await readFile(new URL('_journal.json',meta),'utf8'));
 const latest=journal.entries.at(-1);
 assert.ok(latest&&Number.isSafeInteger(latest.idx)&&latest.idx>=0);
 const snapshot=JSON.parse(await readFile(new URL(`${String(latest.idx).padStart(4,'0')}_snapshot.json`,meta),'utf8'));
 const generated=await generateSQLiteDrizzleJson({...core,...joinSchema},snapshot.id);
 assert.deepEqual(await generateSQLiteMigration(snapshot,generated),[]);
});

test('login request coalescing never extends a cached directory proof deadline',async()=>{
 let clock=1000,calls=0;const lookup=async()=>{calls++;return{corpId:'wxfixture',userId:'T10001A',rtx:'alice'};};
 const prepare=createRtxLoginPreparation(()=>lookup,()=>clock),p=proof();
 const first=await prepare(p);clock=5000;const second=await prepare(p);
 assert.equal(calls,1);assert.equal(second.attributes.wecomVerifiedUntil,first.attributes.wecomVerifiedUntil);
 clock=11001;await prepare(p);assert.equal(calls,2);
});

test('fresh verified directory claims prepare the existing admission policy without granting or fabricating login',async t=>{
 const f=await fixture(t),p=proof(),employee=f.actors.resolveHuman(p)!;let allowed=false,prepared=0;
 const policy={prepare:async(identity:any)=>{assert.equal(identity,p);prepared++;allowed=true;},allows:()=>allowed,allowsBinding:()=>allowed};
 const access=new InstanceAccess(f.members,[],f.actors,['tencentoa'],policy);
 const service=new Collaboration(f.storage,f.actors,undefined,Date.now,id=>access.admitsActor(id));t.after(()=>service.close());
 const evidence={source,members:[{userId:'T10001A',rtx:'alice',subject:'123',identity:p,expiresAt:Date.now()+50000}]};
 await synchronizeRtxMembers(service,source,snapshot,evidence);assert.equal(f.actors.bindings(employee.actorId).length,1);
 await synchronizeRtxMembers(service,source,snapshot,evidence,Date.now,(identity:any)=>policy.prepare(identity));
 assert.equal(prepared,1);assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T10001A'})?.id,employee.actorId);
 assert.equal(f.members.actorMembership(employee.actorId),null,'policy preparation must not insert a membership grant');
 assert.equal(f.registrations(),1,'only the earlier real login registered the Actor');
});

test('an offline owner without the IOA plugin can revoke a pending reservation permanently',async t=>{
 const f=await fixture(t),pending=await f.reserve();
 const administrator=new ActorStore(f.storage);
 try{administrator.setEnabled(pending.id,false,'offline-operator');}finally{administrator.close();}
 assert.throws(()=>f.actors.resolveHuman(proof()),/retired/);
 assert.equal(f.actors.get(pending.id)?.enabled,false);assert.equal(f.registrations(),0);
});

test('Relay directory enrichment cannot change the verified account or extend authentication expiry',async()=>{
 const { RelayAuthentication }=await import('../../../../apps/relay-server/src/authentication');
 const { MemoryRelaySessionStore }=await import('../../../../apps/relay-server/src/session-store');
 const { createHash }=await import('node:crypto');
 const p=proof(),route={instanceId:'entry',origin:'https://login.test'},store=new MemoryRelaySessionStore(),token='a'.repeat(43);
 await store.put('sessions',createHash('sha256').update(token).digest('hex'),{principal:p,route,expiresAt:p.expiresAt},p.expiresAt,10);
 for(const changed of [{...p,subject:'456'},{...p,expiresAt:p.expiresAt+1},{...p,aliases:['login:other']}]){
  const auth=new RelayAuthentication(route.origin,{authenticate:()=>null,preparePrincipal:async()=>changed},[route],undefined,store);
  await assert.rejects(auth.authenticate({headers:{cookie:'__Host-opencraft-relay-session='+token}} as any,route),/cannot change authenticated identity/);
 }
});
