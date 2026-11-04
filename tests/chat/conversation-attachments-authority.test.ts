import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';
import {ActorStore} from '../../packages/access-control/src/actors';import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {Collaboration} from '../../packages/access-control/src/collaboration';import {openServerDatabase} from '../../packages/storage-node/src/server';
import {OpenCraftMessageAttachments} from '../../apps/opencraft-daemon/src/opencraft-message-attachments';
import {encodeConversationRef} from '@opencraft/appserver-protocol/collaboration';
const ref={serverId:'server',threadId:'recorded-thread'};
async function fixture(t:test.TestContext){
 const root=await mkdtemp('/tmp/attachment-authority-'),db=await openServerDatabase(root),actors=new ActorStore(db),store=new OpenCraftMessageAttachments(join(root,'attachments'));
 const person=(subject:string)=>actors.resolveHuman({provider:'local',subject,displayName:subject,expiresAt:Date.now()+3600000})!;
 const human=person('owner'),peer=person('peer'),access=new ThreadAccessStore(join(root,'access.sqlite'),actors);access.created(ref.serverId,ref.threadId,human);
 store.record(ref.threadId,'client-message',[{id:'file',name:'file',mimeType:'text/plain',size:1,location:{kind:'host-file',path:'/MUST_NOT_LEAK'}}]);
 let current=true,reads=0,after:(()=>void)|undefined;let service:Collaboration;
 const port:any={hostId:'host',serverId:'server',directory:()=>({instanceId:'instance',servers:[{serverId:'server',capabilities:{messageAttachments:true}}]}),async messageAttachments(target:any,query:any,context:any,signal:any){reads++;const page=await store.readMetadata({ref:target,actorId:context.actorContext.actorId,generation:context.actorContext.generation,expiresAt:context.actorContext.expiresAt},query,()=>{context.resourceOwner.assertCurrent();service.assertMessageAttachmentsAccess(context.actorContext,target);},signal);after?.();return page;}};
 service=new Collaboration(db,actors,port,Date.now,()=>current,(c,r)=>access.allows(r.serverId,r.threadId,c));
 const command=(context:any=human,extra:any={})=>service.command(context,{action:'messageAttachments',reference:ref,...extra},{submission:{sender:null,actorContext:context,resourceOwner:{id:'synthetic',assertCurrent(){if(!current)throw Error('retired');}}}});
 t.after(async()=>{await service.close();store.close();access.close();actors.close();await db.close();await rm(root,{recursive:true,force:true});});
 return{service,actors,human,peer,access,command,port,get reads(){return reads;},set current(v:boolean){current=v;},set after(v:(()=>void)|undefined){after=v;}};
}
test('human/read authorization intersects private/shared and orchestration grants without a new grant',async t=>{
 const f=await fixture(t);assert.equal((await f.command(f.peer)).entries.length,1);
 f.access.set('server',ref.threadId,'private',1,f.human);await assert.rejects(f.command(f.peer),/conversation_action_denied/);assert.equal((await f.command()).entries.length,1);
 f.access.set('server',ref.threadId,'shared',2,f.human);
 f.service.orchestration.createThread({threadId:ref.threadId,serverId:ref.serverId,driverKind:'codex',ownerActorId:f.human.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'active',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
 await assert.rejects(f.command(f.peer),/conversation_action_denied/);
 f.actors.setGrant(f.peer.actorId,encodeConversationRef(ref),'conversation.read',true,'synthetic');assert.equal((await f.command(f.peer)).entries.length,1);
 f.actors.setGrant(f.peer.actorId,encodeConversationRef(ref),'conversation.read',false,'synthetic');await assert.rejects(f.command(f.peer),/conversation_action_denied/);
});
test('Bot, expiry/generation, forged wire fields and mass denied requests do not reach the metadata reader',async t=>{
 const f=await fixture(t),bot=f.actors.createSession('synthetic Bot',f.human.actorId),key=f.actors.issueCredential(bot.id,Date.now()+60000,f.human.actorId),session=f.actors.authenticateSession(key.token)!;
 await assert.rejects(f.command(session));await assert.rejects(f.command({...f.human,generation:f.human.generation+1}));await assert.rejects(f.command({...f.human,expiresAt:Date.now()-1}));
 for(const extra of [{actorId:f.human.actorId},{principal:{subject:'spoof'}},{source:'spoof'},{executionId:'spoof'},{clientMessageId:'x'.repeat(513)}])await assert.rejects(f.command(f.human,extra));
 f.current=false;for(let n=0;n<100;n++)await assert.rejects(f.command());assert.equal(f.reads,0);
});
test('current authority is rechecked before returning an otherwise valid page',async t=>{
 const f=await fixture(t);f.after=()=>{f.current=false;};await assert.rejects(f.command());assert.equal(f.reads,1);
});
test('missing ports and budget exhaustion cannot masquerade as an empty successful page',async t=>{
 const f=await fixture(t);f.port.messageAttachments=undefined;await assert.rejects(f.command(),/unsupported_capability/);
 let aborted=false;f.port.messageAttachments=async(_:unknown,_q:unknown,_c:unknown,signal:AbortSignal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>{aborted=true;resolve({entries:[]});},{once:true});});
 const keep=setTimeout(()=>{},2000);try{await assert.rejects(f.command(),/attachment_metadata_unavailable/);assert.equal(aborted,true);}finally{clearTimeout(keep);}
});
