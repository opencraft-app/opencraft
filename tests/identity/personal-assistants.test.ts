import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration,type ConversationExecutionPort} from '../../packages/access-control/src/collaboration';
import {createDesktopAccountHost} from '../../plugins/local-account/src/desktop';
import {encodeConversationRef} from '@opencraft/appserver-protocol/collaboration';

async function fixture(t:test.TestContext,execution?:ConversationExecutionPort){
 const directory=await mkdtemp(join(tmpdir(),'personal-assistant-'));
 const storage=await openServerDatabase(directory),actors=new ActorStore(storage),service=new Collaboration(storage,actors,execution);
 const human=(subject:string)=>actors.resolveHuman({provider:'local',subject,displayName:subject,expiresAt:Date.now()+60000})!;
 const alice=human('alice'),bob=human('bob');
 const call=(c:typeof alice,op:string,p:Record<string,unknown>={})=>service.personalAssistant(c,'opencraft/personal-assistant/'+op,p);
 const credential=async(actorId:string)=>{const row=storage.database.prepare('SELECT owner_human_id FROM personal_assistants WHERE actor_id=?').get(actorId)!;
 const owner=row.owner_human_id===alice.actorId?alice:bob;const provision=await service.provisionPersonalAssistant(owner);return actors.authenticateSession(provision.credential.token)!;};
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(directory,{recursive:true,force:true});});
 return {directory,storage,actors,service,alice,bob,call,credential};
}
test('read does not allocate; concurrent explicit claims share one stable resource, revoke/reclaim rotates authority only',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.call(f.alice,'get'),{assistant:null,channelId:null,runtime:{phase:'stopped'}});
 assert.equal(f.actors.list().filter(a=>a.kind==='session').length,0);
 const claims=await Promise.all(Array.from({length:12},()=>f.call(f.alice,'claim')));
 const a=claims[0].assistant;assert.equal(new Set(claims.map(x=>x.assistant.binding.botId)).size,1);
 assert.equal(f.actors.get(a.actorId)?.kind,'session');
 const bot=await f.credential(a.actorId),before=await f.call(bot,'authorize');
 assert.equal(before.binding.owner.id,f.alice.actorId);
 await assert.rejects(f.call(bot,'claim'),/denied/);
 await assert.rejects(f.call(f.bob,'claim',{ownerHumanId:f.alice.actorId}),/invalid_input/);
 await assert.rejects(f.call(f.bob,'claim',{owner:{kind:'project',id:'project'}}),/invalid_input/);
 assert.equal((await f.call(f.bob,'get')).assistant,null);
 await f.call(f.alice,'revoke');await assert.rejects(f.call(bot,'authorize'),/denied/);
 assert.equal((await f.call(f.alice,'claim')).assistant.binding.botId,a.binding.botId);
 await assert.rejects(f.call(bot,'authorize'),/denied/);
 const renewed=await f.credential(a.actorId);assert.notEqual((await f.call(renewed,'authorize')).epoch,before.epoch);
});
test('delegate sees owner groups without joining; membership changes revoke reads, never write/read-marker or DM authority',async t=>{
 const f=await fixture(t),a=(await f.call(f.alice,'claim')).assistant,bot=await f.credential(a.actorId);
 const channels=(c:typeof f.alice,op:string,p:Record<string,unknown>={})=>f.service.communicate(c,'opencraft/channels/'+op,p);
 const g=await channels(f.bob,'group/create',{title:'team',memberActorIds:[f.alice.actorId],clientRequestId:'team'});
 await channels(f.bob,'messages/send',{channelId:g.id,clientMessageId:'one',parts:[{type:'text',text:'project blue'}]});
 assert.equal(f.service.channels.isMember(g.id,bot.actorId),false);
 assert.deepEqual((await f.call(bot,'groups/list')).groups,[{id:g.id,title:'team',kind:'group'}]);
 const before=f.storage.database.prepare('SELECT * FROM actor_channel_reads').all();
 assert.equal((await f.call(bot,'groups/history',{channelId:g.id})).messages[0].text,'project blue');
 assert.equal((await f.call(bot,'groups/search',{channelId:g.id,query:'blue'})).messages.length,1);
 assert.deepEqual(f.storage.database.prepare('SELECT * FROM actor_channel_reads').all(),before);
 await assert.rejects(channels(bot,'messages/send',{channelId:g.id,clientMessageId:'forbidden',parts:[{type:'text',text:'no'}]}),/denied/);
 await assert.rejects(f.call(bot,'groups/send',{channelId:g.id,text:'no'}),/method_not_found/);
 await channels(f.bob,'group/member/set',{channelId:g.id,actorId:f.alice.actorId,present:false,clientRequestId:'remove'});
 assert.deepEqual((await f.call(bot,'groups/list')).groups,[]);
 await assert.rejects(f.call(bot,'groups/history',{channelId:g.id}),/denied/);
 const other=await f.credential((await f.call(f.bob,'claim')).assistant.actorId);
 await assert.rejects(f.call(bot,'groups/list',{ownerHumanId:f.bob.actorId}),/invalid_input/);
 assert.equal((await f.call(other,'groups/list')).groups.length,1);
 const audit=f.storage.database.prepare("SELECT * FROM actor_collaboration_audit WHERE action='personal-assistant.groups/history'").get()!;
 assert.equal(audit.actor_id,bot.actorId);assert.equal(JSON.parse(String(audit.detail)).ownerHumanId,f.alice.actorId);
});
test('delegation revoke fences a held conversation read, including revoke then reclaim',async t=>{
 const started=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
 const execution={serverId:'fixture',hostId:'local-codex',async readBounded(){started.resolve();await resume.promise;return {messages:['secret'],nextCursor:null};}} as unknown as ConversationExecutionPort;
 const f=await fixture(t,execution),a=(await f.call(f.alice,'claim')).assistant,bot=await f.credential(a.actorId);
 const reference=encodeConversationRef({serverId:'fixture',threadId:'shared'});
 const request=f.call(bot,'conversations/history',{reference});await started.promise;
 await f.call(f.alice,'revoke');await f.call(f.alice,'claim');resume.resolve();
 await assert.rejects(request,/denied/);
 const renewed=await f.credential(a.actorId);assert.equal((await f.call(renewed,'conversations/history',{reference})).externalContext,true);
 f.actors.setEnabled(f.alice.actorId,false,'test');await assert.rejects(f.call(bot,'authorize'),/denied/);
});
test('desktop owner and daemon borrow the same installation, Human and personal-assistant authority',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'desktop-assistant-'));
 const owner=await createDesktopAccountHost(directory,()=>''),daemon=await createDesktopAccountHost(directory,()=>'',{storageRole:'borrower'});
 const service=new Collaboration(daemon.storage,daemon.actors,undefined,Date.now,daemon.admittedActor);
 t.after(async()=>{await service.close();await daemon.close();await owner.close();await rm(directory,{recursive:true,force:true});});
 const human=daemon.authenticateSession(owner.createNativeSession())!.actorContext;
 assert.equal(owner.actors.authority,daemon.actors.authority);
 assert.equal((await service.personalAssistant(human,'opencraft/personal-assistant/get')).assistant,null);
 const a=(await service.personalAssistant(human,'opencraft/personal-assistant/claim')).assistant;
 assert.equal(a.binding.owner.id,human.actorId);
 assert.equal(owner.storage.database.prepare('SELECT bot_id FROM personal_assistants').get()!.bot_id,a.binding.botId);
 const {credential:proof}=await service.provisionPersonalAssistant(human);
 const bot=daemon.actors.authenticateSession(proof.token)!;
 assert.equal((await service.personalAssistant(bot,'opencraft/personal-assistant/authorize')).binding.botId,a.binding.botId);
});

test('HTTP and native logical-client transports share the personal-assistant contract and never expose Host credentials',async t=>{
 const {ActorAccess}=await import('../../packages/access-control/src/actor-access');
 const {CollaborationHttpApi}=await import('../../packages/access-control/src/collaboration');
 const {createWorkbenchWebServer}=await import('../../scripts/serve-workbench-web.mjs');
 const {ImChannelsAppServer}=await import('../../scripts/im-channels-appserver.mjs');
 const {LOGICAL_CLIENT_FIELD}=await import('../../packages/app-host-protocol/src/index');
 const f=await fixture(t);
 const principal={provider:'local',subject:'alice',displayName:'alice',expiresAt:Date.now()+60000};
 const access=new ActorAccess(f.actors,{authenticateHuman:r=>r.headers.cookie==='alice'?principal:null,admitted:()=>true,administrator:()=>false});
 const server=await createWorkbenchWebServer({root:f.directory,appServerTarget:null,actorService:access,
   actorCollaborationService:new CollaborationHttpApi(f.service,access),loopbackOnly:true});
 const {port}=await server.listen({host:'127.0.0.1',port:0}),origin='http://127.0.0.1:'+port;
 t.after(()=>server.close());
 const post=(operation:string,body={},token?:string)=>fetch(origin+'/__opencraft_actors/collaboration/personal-assistant/'+operation,
   {method:'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{cookie:'alice'})},body:JSON.stringify(body)});
 assert.equal((await post('claim',{ownerHumanId:f.bob.actorId})).status,400);
 const response=await post('claim');assert.equal(response.status,200);
 const {assistant}=await response.json();
 assert.equal('credential' in assistant,false);
 assert.equal((await post('provision')).status,404);
 const provision=await f.service.provisionPersonalAssistant(f.alice);
 assert.equal(provision.assistant.actorId,assistant.actorId);
 const bot=f.actors.authenticateSession(provision.credential.token)!;assert.ok(bot);
 const authorization=await post('authorize',{},provision.credential.token);assert.equal(authorization.status,200);
 assert.equal((await authorization.json()).binding.botId,assistant.binding.botId);
 const transport=new ImChannelsAppServer(()=>f.service);await transport.connect();t.after(()=>transport.close());
 const pending=new Map<string,(v:any)=>void>();
 const unsub=transport.subscribeMessage(frame=>{const v=JSON.parse(frame);pending.get(v.id)?.(v);});t.after(unsub);
 const context={actorContext:bot,sender:null,resourceOwner:{id:bot.actorId,assertCurrent(){assert.ok(f.actors.isCurrent(bot));}}};
 async function rpc(method:string,params={}) {
   const id=crypto.randomUUID(),promise=new Promise<any>(resolve=>pending.set(id,resolve));
   await transport.sendWithContext(JSON.stringify({jsonrpc:'2.0',id,method,params,[LOGICAL_CLIENT_FIELD]:'bot'}),context);
   const result=await promise;pending.delete(id);return result;
 }
 assert.ok((await rpc('initialize')).result.capabilities.extensions['opencraft/personal-assistant']);
 assert.deepEqual((await rpc('opencraft/personal-assistant/groups/list')).result,{groups:[]});
 assert.ok((await rpc('opencraft/personal-assistant/provision')).error);
 assert.ok((await rpc('opencraft/personal-assistant/claim')).error);
 await post('revoke');assert.ok((await rpc('opencraft/personal-assistant/groups/list')).error);
});

test('membership remove/rejoin while a read waits for delivery cannot revive its old read authority',async t=>{
 const f=await fixture(t),a=(await f.call(f.alice,'claim')).assistant,bot=await f.credential(a.actorId);
 const g=await f.service.communicate(f.bob,'opencraft/channels/group/create',{title:'group',memberActorIds:[f.alice.actorId],clientRequestId:'one'});
 const original=f.service.communicate.bind(f.service),held=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
 f.service.communicate=async(c,method,p={})=>{
   if(method==='personal-assistant/check-groups'){held.resolve();await resume.promise;}
   return original(c,method,p);
 };
 const reading=f.call(bot,'groups/history',{channelId:g.id});await held.promise;
 for(const present of [false,true])await original(f.bob,'opencraft/channels/group/member/set',{channelId:g.id,actorId:f.alice.actorId,present,clientRequestId:String(present)});
 resume.resolve();await assert.rejects(reading,/denied/);
});
test('conversation discovery respects current owner visibility and never widens Bot execution rights',async t=>{
 const refs=['alice','bob','shared'].map(threadId=>({serverId:'fixture',threadId}));
 const execution={serverId:'fixture',hostId:'local-codex',async discover(){return {conversations:refs.map(ref=>({ref,title:ref.threadId})),nextCursor:null};},
   async readBounded(){return {entries:[],nextCursor:null};}} as unknown as ConversationExecutionPort;
 const f=await fixture(t,execution),a=(await f.call(f.alice,'claim')).assistant,bot=await f.credential(a.actorId);
 for(const person of [f.alice,f.bob])f.service.orchestration.createThread({threadId:person===f.alice?'alice':'bob',serverId:'fixture',driverKind:'codex',
   ownerActorId:person.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,
   runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:true,userInputExcerpt:null});
 assert.deepEqual((await f.call(bot,'conversations/list')).conversations.map((c:any)=>c.title),['alice','shared']);
 const other=encodeConversationRef(refs[1]!);
 await assert.rejects(f.call(bot,'conversations/history',{reference:other}),/denied/);
 f.actors.setGrant(f.alice.actorId,other,'conversation.discover',true,'fixture');
 f.actors.setGrant(f.alice.actorId,other,'conversation.read',true,'fixture');
 assert.equal((await f.call(bot,'conversations/list')).conversations.length,3);
 assert.equal((await f.call(bot,'conversations/history',{reference:other})).externalContext,true);
 assert.equal(f.service.conversationAllowed(bot,refs[1]!,'execution.queue'),false);
 f.actors.setGrant(f.alice.actorId,other,'conversation.read',false,'fixture');
 await assert.rejects(f.call(bot,'conversations/history',{reference:other}),/denied/);
});
