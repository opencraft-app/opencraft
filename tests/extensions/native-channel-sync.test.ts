import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {parsePrincipal} from '@opencraft/identity-core';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {ChannelSync,type ChannelArrival,type ChannelSyncTransport} from '../../plugins/im/src/channel-sync';
const png=Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]);
async function until(read:()=>Promise<any>,predicate:(value:any)=>boolean){
  const end=Date.now()+5000;while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,15));}throw Error('condition not reached');
}
async function fixture(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'native-sync-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
  const human=(subject:string)=>actors.resolveHuman(parsePrincipal({provider:'local',subject,displayName:subject,expiresAt:Date.now()+60000})!)!;
  const alice=human('Alice'),bob=human('Bob'),outsider=human('Outsider');
  const call=(context:typeof alice,method:string,params:Record<string,unknown>={})=>service.communicate(context,'opencraft/channels/'+method,params);
  const group=await call(alice,'group/create',{title:'Only group',memberActorIds:[bob.actorId],clientRequestId:'group'});
  const source='fixture/wecom/group';let receive!:(arrival:ChannelArrival)=>Promise<void>;
  const calls:any[]=[];
  const transport:ChannelSyncTransport={bindings:[{source,channelId:group.id}],subscribe(fn){receive=fn;return()=>{};},async send(input){calls.push(input);return 'delivered';},
    images:{async download(){return png;},async upload(){return 'media';},async attribute(input){calls.push(['attribution',input]);return 'delivered';},async send(){calls.push(['image']);return 'delivered';}}};
  const history=(context=bob)=>call(context,'messages/list',{channelId:group.id});
  const send=(key:string,text=key,context=alice)=>call(context,'messages/send',{channelId:group.id,clientMessageId:key,parts:[{type:'text',text}]});
  let sync:ChannelSync|undefined;
  const start=async()=>sync=await ChannelSync.open(transport,service);
  const stop=async()=>{await sync?.close();sync=undefined;};
  t.after(async()=>{await stop();await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  const incoming=(id='external')=>({source,id,author:'Wei',sender:{id:'external-wei',displayName:'Wei'},text:'外部讨论',at:1000});
  return {dir,storage,actors,service,alice,bob,outsider,call,group,source,transport,calls,history,send,start,stop,incoming,receive:(a:ChannelArrival)=>receive(a)};
}
test('external and local messages have one native history, stable IDs, unread and member permissions',async t=>{
  const f=await fixture(t);await f.start();await f.receive(f.incoming());await f.receive(f.incoming());
  assert.equal((await f.call(f.alice,'list')).groups.length,1);
  const received=(await f.history()).messages[0];assert.ok(received.messageId);assert.equal(received.sender.kind,'external');
  assert.equal(f.actors.get(received.sender.id),null);
  assert.equal((await f.service.syncInbox(f.bob)).changes[0].item.unreadCount,1);
  await f.send('local');
  const history=await until(()=>f.history(f.alice),h=>h.messages.length===2&&h.messages[1].status==='delivered');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].requestId,history.messages[1].messageId);
  assert.deepEqual(f.calls[0].presentation,{version:1,sender:{id:f.alice.actorId,role:'human',displayName:'Alice'},format:'text'});
  assert.equal((await f.service.syncInbox(f.bob)).changes[0].item.unreadCount,2);
  await f.call(f.bob,'read',{channelId:f.group.id,throughSequence:history.messages[1].sequence});
  assert.equal((await f.service.syncInbox(f.bob)).changes[0].item.unreadCount,0);
  await assert.rejects(f.history(f.outsider),/channel_denied/);
  await assert.rejects(f.receive({...f.incoming(),text:'changed'}),/idempotency_conflict/);
  await assert.rejects(f.receive({...f.incoming(),source:'unbound'}),/unbound/);
  assert.equal(f.storage.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'shadow_%'").get(),undefined);
});
test('same send retries return the original native message; ambiguous provider effects are not repeated',async t=>{
  const f=await fixture(t);f.transport.send=async input=>{f.calls.push(input);throw Error('connection lost after acceptance');};await f.start();
  const receipt=await f.send('key');
  await until(()=>f.history(f.alice),h=>h.messages[0]?.status==='unknown');
  await f.stop();await f.start();
  const retry=await f.send('key');assert.equal(retry.receipt.messageId,receipt.receipt.messageId);assert.equal(retry.receipt.status,'unknown');assert.equal(f.calls.length,1);
  await assert.rejects(f.send('key','changed'),/idempotency/);
});
test('queued sender removal and rejoin cannot revive the old membership authorization',async t=>{
  const f=await fixture(t);
  const sync=(method:string,params:Record<string,unknown>={})=>f.service.synchronizeChannels({method,params:{incarnation:'first',...params}});
  await sync('configure',{bindings:f.transport.bindings,images:true});await f.send('queued','hello',f.bob);
  const member=(present:boolean)=>f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present,clientRequestId:String(present)});
  await member(false);await member(true);
  assert.equal(await sync('claim'),null);assert.equal((await f.history(f.bob)).messages[0].status,'rejected');
});
test('startup reconciles a claimed send to unknown, fences old callbacks, and retains queued work',async t=>{
  const f=await fixture(t);
  const sync=(incarnation:string,method:string,params:Record<string,unknown>={})=>f.service.synchronizeChannels({method,params:{incarnation,...params}});
  await sync('old','configure',{bindings:f.transport.bindings,images:true});await f.send('claimed');await f.send('queued');const claim=await sync('old','claim');assert.ok(claim);
  await sync('new','configure',{bindings:f.transport.bindings,images:true});
  await assert.rejects(sync('old','settle',{...claim,status:'delivered'}),/retired/);
  const history=await f.history(f.alice);assert.equal(history.messages[0].status,'unknown');assert.equal(history.messages[1].status,'sending');
  assert.equal((await sync('new','claim')).messageId,history.messages[1].messageId);
  await assert.rejects(f.service.communicate(f.alice,'configure',{bindings:[]}),/method_not_found/);
});
test('images use native permissions, native sync revisions and immutable retry payloads',async t=>{
  const f=await fixture(t);const gate=Promise.withResolvers<Uint8Array>();f.transport.images!.download=()=>gate.promise;await f.start();
  await f.receive({...f.incoming('image'),text:'',mediaId:'m'});
  const snapshot=await f.call(f.alice,'sync',{channelId:f.group.id});assert.equal(snapshot.messages[0].image.state,'pending');
  gate.resolve(png);
  const delta=await until(()=>f.call(f.alice,'sync',{channelId:f.group.id,cursor:snapshot.cursor}),h=>h.messages[0]?.image?.state==='ready');
  assert.equal(delta.kind,'delta');assert.equal(delta.messages[0].messageId,snapshot.messages[0].messageId);
  const image=await f.service.communicate(f.bob,'channel/image',{channelId:f.group.id,sequence:snapshot.messages[0].sequence});assert.deepEqual(image.bytes,png);
  await assert.rejects(f.service.communicate(f.outsider,'channel/image',{channelId:f.group.id,sequence:snapshot.messages[0].sequence}),/channel_denied/);
  const payload={channelId:f.group.id,clientMessageId:'upload',type:'image/png',bytes:png};
  const result=await f.service.communicate(f.alice,'channel/image/send',payload);
  await until(()=>f.history(f.alice),h=>h.messages[1]?.status==='delivered');
  const again=await f.service.communicate(f.alice,'channel/image/send',payload);assert.equal(result.receipt.messageId,again.receipt.messageId);
  await assert.rejects(f.service.communicate(f.alice,'channel/image/send',{...payload,bytes:Uint8Array.from([...png,4])}),/idempotency/);
  assert.equal(f.calls.length,2);
});
test('removal during image upload prevents attribution and image handoff',async t=>{
  const f=await fixture(t),upload=Promise.withResolvers<string>(),started=Promise.withResolvers<void>();
  f.transport.images!.upload=()=>{started.resolve();return upload.promise;};await f.start();
  await f.service.communicate(f.bob,'channel/image/send',{channelId:f.group.id,clientMessageId:'image',type:'image/png',bytes:png});await started.promise;
  await f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
  upload.resolve('uploaded');await until(async()=>f.storage.database.prepare('SELECT state FROM actor_channel_outbox').get(),r=>r.state!=='sending');assert.equal(f.calls.length,0);
});
test('durable inline bytes repair a transient image failure and fence a late failure',async t=>{
  const f=await fixture(t);f.transport.images!.download=async()=>{throw Error('temporary media failure');};await f.start();
  await f.receive({...f.incoming('recover-image'),text:'',mediaId:'recover'});
  await until(()=>f.history(f.alice),h=>h.messages[0]?.image?.state==='unavailable');
  const row=f.storage.database.prepare('SELECT incarnation FROM actor_channel_sources WHERE source=?').get(f.source)!;
  const message=(await f.history(f.alice)).messages[0];
  const ready=(bytes?:Uint8Array)=>f.service.synchronizeChannels({method:'imageReady',params:{source:f.source,incarnation:row.incarnation,messageId:message.messageId,bytes}});
  assert.deepEqual(await ready(png),{ready:true});assert.deepEqual(await ready(),{ready:true});
  assert.equal((await f.history(f.alice)).messages[0].image.state,'ready');
  assert.deepEqual((await f.service.communicate(f.bob,'channel/image',{channelId:f.group.id,sequence:message.sequence})).bytes,png);
});
test('Relay cutover preserves the original image identity across changed media references',async t=>{
  const f=await fixture(t);await f.start();
  await f.receive({...f.incoming('cutover'),text:'',mediaId:'provider-id'});
  await f.receive({...f.incoming('cutover'),text:'',mediaId:'relay-reference',mediaIdentity:'provider-id',inlineImage:png});
  assert.equal((await f.history(f.alice)).messages.length,1);
  assert.equal((await f.history(f.alice)).messages[0].image.state,'ready');
  await assert.rejects(f.receive({...f.incoming('cutover'),text:'',mediaId:'relay-reference',mediaIdentity:'different',inlineImage:png}),/idempotency_conflict/);
});
test('bindings are explicit and one-to-one; removed bindings do not replay messages on reconnection',async t=>{
  const f=await fixture(t);await f.start();await f.stop();await f.send('while-unbound');await f.start();
  await new Promise(r=>setTimeout(r,50));assert.equal(f.calls.length,0);
  await assert.rejects(ChannelSync.open({...f.transport,bindings:[...f.transport.bindings,{source:'other',channelId:f.group.id}]},f.service),/invalid_channel_binding/);
  assert.equal((await f.history()).messages.length,1);
});

test('queued sends retain their original credential and expiry authority',async t=>{
  const f=await fixture(t),bot=f.actors.createSession('Relay bot',f.alice.actorId);
  const credential=f.actors.issueCredential(bot.id,Date.now()+60000,f.alice.actorId),context=f.actors.authenticateSession(credential.token)!;
  await f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:bot.id,present:true,clientRequestId:'add-bot'});
  const sync=(method:string,params:Record<string,unknown>={})=>f.service.synchronizeChannels({method,params:{incarnation:'credentials',...params}});
  await sync('configure',{bindings:f.transport.bindings,images:true});
  await f.send('revoked','bot message',context);
  const expiring={...f.alice,expiresAt:Date.now()+1000};
  await f.send('expired','human message',expiring);
  f.actors.revokeCredential(credential.credentialId,f.alice.actorId);
  await new Promise(r=>setTimeout(r,1050));
  assert.equal(await sync('claim'),null);
  assert.deepEqual(f.storage.database.prepare('SELECT state FROM actor_channel_outbox ORDER BY message_id').all().map(r=>r.state),['rejected','rejected']);
});

test('native search includes external arrivals and local messages under the same membership and cursor',async t=>{
  const f=await fixture(t);await f.start();await f.receive({...f.incoming(),text:'Budget 100%_ok'});await f.send('local-search','Budget 200%_ok');
  const search=(context=f.alice,extra={})=>f.call(context,'messages/search',{channelId:f.group.id,query:'budget',limit:1,...extra});
  const first=await search();assert.equal(first.messages.length,1);assert.equal(first.hasEarlier,true);assert.equal(first.messages[0].text,'Budget 200%_ok');
  const earlier=await search(f.alice,{before:first.messages[0].sequence});assert.equal(earlier.messages[0].sender.kind,'external');assert.equal(earlier.hasEarlier,false);
  assert.equal((await search(f.alice,{query:'%_'})).messages.length,1);
  await assert.rejects(search(f.outsider),/channel_denied/);await assert.rejects(search(f.alice,{limit:500}),/invalid_input/);
});

test('actual WeCom transport opens through native sync with either registered callback path',async t=>{
 const f=await fixture(t);const {createWeComChannelTransport}=await import('../../products/join/plugins/wecom/channel-transport.mjs');
 for(const callbackPath of ['/__opencraft_im/channel-callback/wecom','/__opencraft_im/shadow-callback/wecom']){
  const transport=createWeComChannelTransport({corpId:'wxfixture',corpSecret:'synthetic-fixture',serviceId:'fwfixture',token:'fixture',aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/,''),localGroups:[{chatId:'room',channelId:f.group.id}],callbackPath,fetcher:async()=>{throw Error('No provider request expected');}});
  const sync=await ChannelSync.open(transport,f.service);assert.equal(sync.transport.callback!.path,callbackPath);await sync.close();
 }
 await assert.rejects(ChannelSync.open({...f.transport,callback:{path:'/__opencraft_im/shadow-callback/arbitrary',async handle(){}}},f.service),/Invalid channel callback route/);
});

test('global message search includes synchronized WeCom history, paginates and fences membership',async t=>{
  const f=await fixture(t);await f.start();
  await f.receive({...f.incoming('wecom-search'),text:'讨论 IOA 发布 _%'});
  await f.send('search-local','本地 ioa 回复');
  const other=await f.call(f.outsider,'group/create',{title:'Private',memberActorIds:[],clientRequestId:'private'});
  await f.call(f.outsider,'messages/send',{channelId:other.id,clientMessageId:'private',parts:[{type:'text',text:'ioa secret'}]});
  const search=(context=f.bob,params:Record<string,unknown>={query:'ioa'})=>f.call(context,'search',params);
  const first=await search(f.bob,{query:' IOA ',limit:1});
  assert.equal(first.matches.length,1);assert.equal(first.matches[0].message.text,'本地 ioa 回复');
  assert.ok(first.nextBefore);
  const second=await search(f.bob,{query:'ioa',before:first.nextBefore,limit:1});
  assert.equal(second.matches.length,1);assert.equal(second.matches[0].channel.id,f.group.id);
  assert.equal(second.matches[0].message.sender.kind,'external');assert.equal(second.nextBefore,null);
  const context=await f.call(f.bob,'messages/around',{channelId:f.group.id,sequence:second.matches[0].message.sequence});
  assert.equal(context.messages[0].messageId,second.matches[0].message.messageId);
  assert.equal((await search(f.bob,{query:'_%'})).matches.length,1);
  assert.equal((await search(f.outsider)).matches.length,1);
  assert.equal((await search(f.outsider)).matches[0].channel.id,other.id);
  await f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove-search'});
  assert.deepEqual(await search(f.bob,{query:'ioa',before:first.nextBefore}),{matches:[],nextBefore:null});
  await assert.rejects(f.call(f.bob,'messages/around',{channelId:f.group.id,sequence:second.matches[0].message.sequence}),/channel_denied/);
  await assert.rejects(search(f.bob,{query:''}),/invalid_input/);
  await assert.rejects(search(f.bob,{query:'ioa',limit:51}),/invalid_input/);
  await assert.rejects(search(f.bob,{query:'ioa',before:0}),/invalid_input/);
});

test('search context is bounded around the exact message and never admits a foreign sequence',async t=>{
 const f=await fixture(t);
 const sent=[];for(let i=0;i<80;i++)sent.push((await f.send('context-'+i)).receipt);
 const page=await f.call(f.bob,'messages/around',{channelId:f.group.id,sequence:sent[40].sequence});
 assert.equal(page.messages.length,50);assert.equal(page.messages[25].messageId,sent[40].messageId);assert.equal(page.hasEarlier,true);
 const group=await f.call(f.alice,'group/create',{title:'Other',memberActorIds:[f.bob.actorId],clientRequestId:'other-context'});
 await assert.rejects(f.call(f.bob,'messages/around',{channelId:group.id,sequence:sent[40].sequence}),/invalid_input/);
});

test('a WeCom sender bound to an OpenCraft human shows that human; raw and resolved labels otherwise stay as recorded',async t=>{
  const f=await fixture(t);
  const corp='wxcorp1',source=JSON.stringify(['wecom-customer-service',corp,'fwservice','wrgroup1']);
  const channelId=f.group.id;
  // Rebind the fixture group to a real WeCom-shaped source; the transport binding is the native one.
  f.transport.bindings=[{source,channelId}];
  await f.start();
  f.actors.bindHuman(f.alice,parsePrincipal({provider:'wecom.'+corp,subject:'T40930008A',displayName:'T40930008A',expiresAt:Date.now()+60000})!);
  const arrive=(id:string,sender:string,label=sender)=>f.receive({source,id,author:sender,sender:{id:sender,displayName:label},text:'hi '+id,at:1000});
  await arrive('linked','T40930008A');
  await arrive('unbound','T99999999A');
  await arrive('resolved','T40930008A','alice-from-wecom');
  const linkedMessage=(await f.history()).messages.find((m:any)=>m.text==='hi linked');
  const messages=Object.fromEntries((await f.history()).messages.map((m:any)=>[m.text.slice(3),m]));
  assert.equal(messages.linked.sender.displayName,'Alice','a raw bound identity shows the OpenCraft name');
  assert.equal(messages.linked.author,'Alice');
  assert.equal(messages.linked.sender.kind,'external','authorship stays external');
  assert.equal(messages.linked.sender.isSelf,false);
  assert.equal(messages.unbound.sender.displayName,'T99999999A','an unbound identity is not guessed');
  assert.equal(messages.resolved.sender.displayName,'alice-from-wecom','a provider-resolved label is kept');
  // Quotes use the same projection.
  const reply=await f.call(f.bob,'messages/send',{channelId,clientMessageId:'reply',parts:[{type:'text',text:'re'}],replyToMessageId:linkedMessage.messageId});
  assert.equal(reply.receipt.replyTo.author,'Alice');
  // The stored record is unchanged; only the projection follows the binding.
  assert.equal(f.storage.database.prepare('SELECT author_display_name n FROM actor_messages WHERE id=?').get(linkedMessage.messageId).n,'T40930008A');
  // A disabled or unbound human no longer lends its name.
  f.actors.bindHuman(f.alice,parsePrincipal({provider:'local',subject:'Alice-2',displayName:'Alice',expiresAt:Date.now()+60000})!);
  f.actors.unbindHuman(f.alice,{provider:'wecom.'+corp,subject:'T40930008A'});
  const alice=f.actors.resolveHuman(parsePrincipal({provider:'local',subject:'Alice',displayName:'Alice',expiresAt:Date.now()+60000})!)!;
  assert.equal((await f.call(alice,'messages/list',{channelId})).messages.find((m:any)=>m.text==='hi linked').sender.displayName,'T40930008A');
});

test('only the group owner renames a group; retries are idempotent and members observe the new title',async t=>{
  const f=await fixture(t);
  const rename=(context:typeof f.alice,title:unknown,key='rename')=>f.call(context,'group/rename',{channelId:f.group.id,title,clientRequestId:key});
  assert.equal((await f.call(f.alice,'list')).groups[0].canRename,true);
  assert.equal((await f.call(f.bob,'list')).groups[0].canRename,false);
  const notified:any[]=[];const stop=f.service.channels.onChange(change=>notified.push(change));
  const renamed=await rename(f.alice,'  产品讨论  ');
  assert.equal(renamed.title,'产品讨论');assert.equal(renamed.canRename,true);
  assert.deepEqual(notified,[{channelId:f.group.id,directory:true}]);
  assert.equal((await f.call(f.bob,'list')).groups[0].title,'产品讨论','members see the new title');
  assert.equal((await rename(f.alice,'产品讨论')).title,'产品讨论','replay returns the current summary');
  assert.equal(notified.length,1,'an idempotent replay does not notify again');
  await assert.rejects(rename(f.alice,'Other'),/idempotency/);
  assert.equal((await rename(f.alice,'产品讨论','same-title')).title,'产品讨论');assert.equal(notified.length,1,'an unchanged title does not notify');
  await assert.rejects(rename(f.bob,'Hijack','bob'),/channel_denied/);
  await assert.rejects(rename(f.outsider,'Hijack','outsider'),/channel_denied/);
  await assert.rejects(rename(f.alice,'   ','blank'),/invalid/);
  await assert.rejects(rename(f.alice,'x'.repeat(129),'long'),/invalid/);
  await assert.rejects(rename(f.alice,'line\nbreak','control'),/invalid/);
  const direct=await f.call(f.alice,'direct/open',{actorId:f.bob.actorId}).catch(()=>null);
  if(direct)await assert.rejects(f.call(f.alice,'group/rename',{channelId:direct.id,title:'DM',clientRequestId:'dm'}),/channel_denied/);
  stop();
  assert.equal((await f.call(f.alice,'list')).groups.find((g:any)=>g.id===f.group.id).title,'产品讨论');
});
