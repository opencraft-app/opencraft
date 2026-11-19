import '../../plugins/wecom/assistant-install.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';import {ActorStore} from '../../../../packages/access-control/src/actors';import {Collaboration} from '../../../../packages/access-control/src/collaboration';
import {syncHash} from '../../plugins/wecom/group-sync.mjs';
import {createGroupSyncPump} from '../../plugins/wecom/mirror/group-sync-target.mjs';

async function fixture(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'wecom-create-')),old=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=dir+'-ws';
  const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors),db=storage.database;
  t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
  const human=(id:string)=>actors.resolveHuman({provider:'tencentoa',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
  const alice=human('alice'),bob=human('bob'),dave=human('dave');
  for(const [c,id] of [[alice,'WA'],[bob,'WB']] as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+3600000});
  const channel=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p);
  const call=(method:string,params:any)=>service.synchronizeChannels({method,params});
  return {service,db,alice,bob,dave,channel,call};
}
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','newroom']);


import{storeInboundFile,inboundFileId}from'../../plugins/wecom/inbound-files.mjs';
test('an authenticated inbound journal publishes a real downloadable attachment without rewriting text or duplicating history',async t=>{
 const f=await fixture(t),g:any=await f.channel(f.alice,'group/create',{title:'File group',memberActorIds:[f.bob.actorId],clientRequestId:'g'});await f.call('configure',{incarnation:'files',bindings:[{source,channelId:g.id}]});
 const arrival={source,id:'external-file',author:'Other',text:'[file] report.pdf',at:1000};const first:any=await f.call('ingest',{incarnation:'files',source,arrival});
 const id=inboundFileId('synthetic',source,arrival.id),bytes=new Uint8Array([1,2,3,4]);await storeInboundFile(id,'report.pdf',async()=>bytes,{source});
 const args={source,messageId:first.messageId,externalId:arrival.id,id};await assert.rejects(f.service.communicate(f.alice,'join/wecom-file/admit',args),/method_not_found/);
 await f.call('join/wecom-file/admit',args);await f.call('join/wecom-file/admit',args);
 const history:any=await f.channel(f.bob,'messages/list',{channelId:g.id});assert.equal(history.messages.length,1);assert.equal(history.messages[0].text,arrival.text);assert.deepEqual(history.messages[0].attachment,{name:'report.pdf',type:'application/octet-stream',size:4});
 const downloaded:any=await f.channel(f.bob,'attachments/read',{channelId:g.id,sequence:history.messages[0].sequence,offset:0});assert.deepEqual(Buffer.from(downloaded.base64,'base64'),Buffer.from(bytes));
 for(const present of [false,true]){await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.bob.actorId,present,clientRequestId:'set-'+present});if(!present)await assert.rejects(f.channel(f.bob,'attachments/read',{channelId:g.id,sequence:history.messages[0].sequence,offset:0}),/denied/);}
 await assert.rejects(f.call('join/wecom-file/admit',{...args,externalId:'wrong'}),/retired/);await assert.rejects(f.call('join/wecom-file/admit',{...args,source:JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','foreign'])}),/retired/);
});
test('native outbound file bytes use the existing authenticated Relay file-send endpoint, never the text placeholder',async t=>{
 const f=await fixture(t),seen:any[]=[];const{createMirrorTarget}=await import('../../plugins/wecom/mirror/target.mjs');
 const transport=await createMirrorTarget({relayOrigin:'http://127.0.0.1/',allowLoopbackInsecure:true,serverId:'fixture',credential:'x'.repeat(43),corpId:'wxfixture'},{collaboration:f.service},async(url:any,p:any)=>{seen.push([String(url),JSON.parse(p.body)]);return Response.json({status:'delivered'});});
 try{const bytes=Uint8Array.from([1,2,3,4]);assert.equal(transport.files,true);assert.equal(await transport.send({source,requestId:'file-native',text:'[Attachment: report.pdf]',author:'Alice',attachment:{name:'report.pdf',type:'application/pdf',bytes}},new AbortController().signal),'delivered');assert.equal(seen.length,1);assert.ok(seen[0][0].endsWith('/file-send'));assert.equal(seen[0][1].name,'report.pdf');assert.equal(seen[0][1].source,source);assert.deepEqual(Buffer.from(seen[0][1].bytes,'base64'),Buffer.from(bytes));}finally{await transport.close();}
});
