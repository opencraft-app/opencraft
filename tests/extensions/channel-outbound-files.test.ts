import{installCommunicationExtension}from'../../packages/access-control/src/communication-extension';
import{communicationExtension}from'../fixtures/channel-file-extension.mjs';
installCommunicationExtension(communicationExtension,new URL('../fixtures/channel-file-extension.mjs',import.meta.url).href);
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

const file=(f:any,key:string,bytes=new Uint8Array([1,2,3]),c=f.alice)=>f.call(c,'attachments/send',{channelId:f.group.id,clientMessageId:key,name:'report.pdf',type:'application/pdf',base64:Buffer.from(bytes).toString('base64')});
test('a real generic file reaches the existing durable outbox and transport with exact bytes, not a filename',async t=>{
 const f=await fixture(t);f.transport.files=true;await f.start();const bytes=Uint8Array.from({length:200000},(_,i)=>i%251),receipt=await file(f,'file',bytes);
 await until(()=>f.history(f.alice),h=>h.messages.at(-1)?.status==='delivered');assert.equal(f.calls.length,1);assert.equal(f.calls[0].requestId,receipt.receipt.messageId);assert.equal(f.calls[0].attachment.name,'report.pdf');assert.deepEqual(f.calls[0].attachment.bytes,bytes);
 await file(f,'file',bytes);assert.equal((await f.history()).messages.length,1);assert.equal(f.calls.length,1);
});
test('a transport without generic-file capability rejects visibly instead of sending the attachment placeholder text',async t=>{
 const f=await fixture(t);await f.start();await file(f,'not-supported');await until(()=>f.history(f.alice),h=>h.messages.at(-1)?.status==='rejected');assert.equal(f.calls.length,0);
});
test('every file chunk revalidates sender membership; removal and rejoin do not revive a queued grant',async t=>{
 const f=await fixture(t);f.transport.files=true;let removed=false;
 const port={channels:f.service.channels,async synchronizeChannels(c:any){
  if(c.method==='attachmentChunk'&&c.params.offset>0&&!removed){removed=true;for(const present of [false,true])await f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present,clientRequestId:'member-'+present});}
  return f.service.synchronizeChannels(c);
 }};
 const sync=await ChannelSync.open(f.transport,port);try{await file(f,'revoked',new Uint8Array(100000),f.bob);await until(()=>f.history(f.bob),h=>h.messages.at(-1)?.status==='rejected');assert.equal(removed,true);assert.equal(f.calls.length,0);}finally{await sync.close();}
});
test('an ambiguous generic-file handoff is never replayed after transport restart',async t=>{
 const f=await fixture(t);f.transport.files=true;let sends=0;f.transport.send=async()=>{sends++;throw Error('reply_lost');};await f.start();await file(f,'uncertain');await until(()=>f.history(f.alice),h=>h.messages.at(-1)?.status==='unknown');await f.stop();await f.start();await new Promise(r=>setTimeout(r,100));assert.equal(sends,1);assert.equal((await f.history(f.alice)).messages.at(-1)?.status,'unknown');
});
test('private attachment chunks cannot be read with a wrong attempt, source, or after retirement',async t=>{
 const f=await fixture(t),invoke=(method:string,params:any={})=>f.service.synchronizeChannels({method,params:{incarnation:'test',...params}});await invoke('configure',{bindings:f.transport.bindings});await file(f,'queued');const claim=await invoke('claim');
 const p={source:f.source,messageId:claim.messageId,attemptId:claim.attemptId,offset:0};assert.equal((await invoke('attachmentChunk',p)).bytes.length,3);
 await assert.rejects(invoke('attachmentChunk',{...p,attemptId:'wrong'}),/retired/);await assert.rejects(invoke('attachmentChunk',{...p,source:'other'}),/retired/);await invoke('configure',{bindings:[]});await assert.rejects(invoke('attachmentChunk',p),/retired/);
});
