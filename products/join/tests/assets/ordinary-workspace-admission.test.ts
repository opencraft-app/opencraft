import { ActorStore } from '@opencraft/access-control/actors';
import { InstanceAccess, MembershipStore } from '@opencraft/access-control';
import { parsePrincipal } from '@opencraft/identity-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitOrdinaryWorkspace, admitOrdinaryBrowserOwner } from '../../assets/ordinary-workspace-admission';
import type { Actor } from '@opencraft/identity-core/actors';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
function fixture() {
 const actor:Actor={id:'human-a',kind:'human',displayName:'Alice',enabled:true,generation:1,createdAt:1,createdBy:null};
 let stopped=false,member=true,login=true,owner=true,revision=0;
 const bindings=[{provider:'tencentoa',subject:'alice-subject'}];
 const context:TransportSubmissionContext={sender:null,actorContext:{actorId:actor.id,generation:1,expiresAt:Date.now()+60000,credentialId:null},
  executionPrincipal:{provider:'tencentoa',subject:'alice-subject',loginName:'display-only'},validUntil:Date.now()+60000,
  resourceOwner:{id:actor.id,assertCurrent(){if(!owner)throw Error('request retired')}}};
 const dependencies={hostId:'local-codex',current:()=>!stopped,actors:{
  get:(id:string)=>id===actor.id?actor:null,bindings:()=>bindings,
  isCurrent:(c:NonNullable<TransportSubmissionContext['actorContext']>)=>login&&c.actorId===actor.id&&c.expiresAt>Date.now()&&c.generation===actor.generation},
  getInstanceAccess:()=>({store:{revocationRevision:()=>revision},admitsActor:(id:string)=>member&&id===actor.id})};
 return {actor,context,bindings,dependencies,stop(){stopped=true},revoke(){member=false;revision++},enable(){member=true},expireLogin(){login=false},retireRequest(){owner=false}};
}
test('only current verified Human identity determines ordinary workspace and vault scope',()=>{
 const f=fixture(),a=admitOrdinaryWorkspace(f.context,f.dependencies);
 assert.deepEqual(a.authority,{principalId:'human-a',hostId:'local-codex'});
 assert.equal(a.catalog.scope,'tencentoa:alice-subject');assert.equal(a.catalog.current(),true);
 const forged={...f.context,executionPrincipal:{provider:'tencentoa',subject:'other'}};
 assert.throws(()=>admitOrdinaryWorkspace(forged,f.dependencies),/unavailable/);
 assert.throws(()=>admitOrdinaryWorkspace({sender:null},f.dependencies),/unavailable/);
});
test('request expiry and retirement block new admission but do not replace durable lease authority',async()=>{
 const f=fixture(),a=admitOrdinaryWorkspace(f.context,f.dependencies);
 f.expireLogin();f.retireRequest();await a.authorize();
 assert.throws(()=>admitOrdinaryWorkspace(f.context,f.dependencies),/retired/);
 f.revoke();assert.equal(a.catalog.current(),false);await assert.rejects(a.authorize(),/unavailable/);
});
test('generation, binding changes, shutdown and disabled users revoke existing work',async()=>{
 const changes=[(f:ReturnType<typeof fixture>)=>Object.assign(f.actor,{generation:2}),
  (f:ReturnType<typeof fixture>)=>Object.assign(f.actor,{enabled:false}),
  (f:ReturnType<typeof fixture>)=>{f.bindings[0]!.subject='rebound'},
  (f:ReturnType<typeof fixture>)=>{f.bindings.push({provider:'tencentoa',subject:'second'})},
  (f:ReturnType<typeof fixture>)=>f.stop()];
 for(const change of changes){const f=fixture(),a=admitOrdinaryWorkspace(f.context,f.dependencies);change(f);
  assert.equal(a.catalog.current(),false);await assert.rejects(a.authorize(),/unavailable/);}
});
test('mutating request identity cannot redirect admitted work to another user',async()=>{
 const f=fixture(),a=admitOrdinaryWorkspace(f.context,f.dependencies);
 Object.assign(f.context.executionPrincipal!,{subject:'bob',loginName:'bob'});Object.assign(f.context.actorContext!,{actorId:'bob'});
 await a.authorize();assert.equal(a.authority.principalId,'human-a');assert.equal(a.catalog.scope,'tencentoa:alice-subject');
});
test('Bot/session actors, expired request context and unadmitted members are rejected',()=>{
 const f=fixture();Object.assign(f.actor,{kind:'session'});
 assert.throws(()=>admitOrdinaryWorkspace(f.context,f.dependencies),/unavailable/);
 Object.assign(f.actor,{kind:'human'});Object.assign(f.context,{validUntil:0});
 assert.throws(()=>admitOrdinaryWorkspace(f.context,f.dependencies),/unavailable/);
 Object.assign(f.context,{validUntil:Date.now()+60000});f.revoke();
 assert.throws(()=>admitOrdinaryWorkspace(f.context,f.dependencies),/unavailable/);
});

test('membership disable/re-enable between checks never revives an older lease',async()=>{
 const f=fixture(),a=admitOrdinaryWorkspace(f.context,f.dependencies);
 f.revoke();f.enable();assert.equal(a.catalog.current(),false);await assert.rejects(a.authorize(),/unavailable/);
 await admitOrdinaryWorkspace(f.context,f.dependencies).authorize();
});

test('real ActorStore and membership preserve workspace owner across restart and fence revocations',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ordinary-admission-')),path=join(dir,'actors.sqlite');
 let actors=new ActorStore(path);const members=new MembershipStore(join(dir,'members.sqlite'));
 t.after(()=>{actors.close();members.close();rmSync(dir,{recursive:true,force:true})});
 const principal=parsePrincipal({provider:'tencentoa',subject:'fixture-subject',displayName:'Alice',expiresAt:Date.now()+60000});
 let actorContext=actors.resolveHuman(principal)!;
 members.set(principal,'member',true,'fixture-operator');
 let access=new InstanceAccess(members,[],actors);
 const deps=()=>({actors,getInstanceAccess:()=>access,hostId:'local-codex',current:()=>true});
 const request=():TransportSubmissionContext=>({sender:null,actorContext,executionPrincipal:{provider:principal.provider,subject:principal.subject},validUntil:principal.expiresAt});
 const a=admitOrdinaryWorkspace(request(),deps());await a.authorize();
 const first={...a.authority};
 members.set(principal,'member',false,'fixture-operator');members.set(principal,'member',true,'fixture-operator');
 await assert.rejects(a.authorize(),/unavailable/);
 actors.close();actors=new ActorStore(path);actorContext=actors.resolveHuman({...principal,displayName:'Renamed'})!;
 access=new InstanceAccess(members,[],actors);
 const b=admitOrdinaryWorkspace(request(),deps());assert.deepEqual(b.authority,first);await b.authorize();
 actors.setEnabled(actorContext.actorId,false,'fixture-operator');actors.setEnabled(actorContext.actorId,true,'fixture-operator');
 await assert.rejects(b.authorize(),/unavailable/);
});

test('durable browser owner resolves current binding without fabricating a login',async()=>{
 const f=fixture(); f.expireLogin(); f.retireRequest();
 const admission=admitOrdinaryBrowserOwner(f.actor.id,f.dependencies);
 assert.equal(admission.catalog.scope,'tencentoa:alice-subject');await admission.authorize();
 assert.throws(()=>admitOrdinaryBrowserOwner('foreign',f.dependencies),/unavailable/);
 f.revoke(); f.enable(); await assert.rejects(admission.authorize(),/unavailable/);
 Object.assign(f.actor,{kind:'session'});
 assert.throws(()=>admitOrdinaryBrowserOwner(f.actor.id,f.dependencies),/unavailable/);
});
