import {createWeComTurnNotifications} from '../turn-notifications.mjs';
import {createAvatarDirectorySync} from '../../tencentoa/src/avatar-directory-sync.mjs';
import {avatarProfiles} from '../../tencentoa/src/avatar-profiles.mjs';
import {deploymentPaths} from '../../../../../scripts/container-deployment/paths.mjs';
import {synchronizeRtxMembers} from '../../tencentoa/src/rtx-directory.mjs';
import{parseForwardedRecord}from'@opencraft/appserver-protocol';
import {createGroupSyncPump} from './group-sync-target.mjs';
import {resolveNativeMemberIdentities} from '../native-member-target.mjs';
import {mirrorFailureReporter} from './target-diagnostic.mjs';
import {installProviderReader} from '../provider-query.mjs';
import {nativePicture} from '../picture-codec.mjs';
import { channelImageType } from '@opencraft/appserver-protocol';
import { resolveNestedMedia } from '../nested-media.mjs';
import { stagedGroupFile, stagedGroupAction, dropGroupFile, saveGroupOperationResult } from '../outbound-files.mjs';
import { transcribeVoice, MAX_VOICE_BYTES } from '../voice-text.mjs';
import { inboundFileId, inboundFileLine, storeInboundFile, adoptInboundFileSource, reserveInboundFileSource, MAX_INBOUND_FILE_BYTES } from '../inbound-files.mjs';
import { readFile } from 'node:fs/promises';
import { Agent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { MIRROR_PATH } from './service.mjs';
import {createInboundJournal} from './inbound-journal.mjs';

/** Pulls over authenticated TLS. Native channel storage remains the only target timeline. */
export async function createMirrorTarget(config,{collaboration,prepareDirectoryIdentity,resolveNativeMemberRtx},fetcher,{directoryOnly=false,transcribe=transcribeVoice,onError=mirrorFailureReporter({credential:config.credential})}={}) {
  const origin=new URL(config.relayOrigin);
  if((origin.protocol!=='https:'&&!(config.allowLoopbackInsecure===true&&origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))
    ||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!/^[A-Za-z0-9._-]{1,128}$/u.test(config.serverId)
    ||!/^[-_A-Za-z0-9]{43}$/u.test(config.credential)||!/^wx[a-z0-9]+$/iu.test(config.corpId)||!collaboration?.synchronizeChannels)throw Error('invalid_mirror_target');
  const agent=config.caFile?new Agent({connect:{ca:await readFile(config.caFile)}}):undefined;
  fetcher??=(url,options)=>undiciFetch(url,{...options,...(agent?{dispatcher:agent}:{})});
  const abort=new AbortController();let stopped=false,timer,job=Promise.resolve(),consume,removeChanges,notificationReadyUntil=0;
  const journal=directoryOnly?null:createInboundJournal(config.serverId);
  const deliveries=new Map();
  const call=(method,params)=>collaboration.synchronizeChannels({method,params});
  const bindings=directoryOnly?[]:await call('mirrorSources',{corpId:config.corpId});
  const migrations=new Map(bindings.map(b=>[b.source,0]));
  async function migrateLegacyFiles() {
    const first=migrations.entries().next();if(first.done)return;
    const [source,after]=first.value;
    const rows=await call('externalHistory',{source,after,query:'资料编号 f'});
    if(!Array.isArray(rows)||rows.length>32)throw Error('invalid_external_history');
    if(!rows.length){migrations.delete(source);return;}
    for(const row of rows) {
      if(!Number.isSafeInteger(row.seq)||row.seq<=after||typeof row.externalId!=='string'||typeof row.content!=='string')throw Error('invalid_external_history');
      const ids=[inboundFileId(config.credential,source,row.externalId),...Array.from({length:16},(_,i)=>inboundFileId(config.credential,source,row.externalId+':nested:'+i))];
      for(const id of ids)if(row.content.includes('资料编号 '+id)&&adoptInboundFileSource(id,source)&&id===ids[0]&&typeof row.messageId==='string')await call('join/wecom-file/admit',{source,messageId:row.messageId,externalId:row.externalId,id}).catch(()=>{});
    }
    migrations.set(source,rows.at(-1).seq);
  }
  async function request(action,payload,signal=abort.signal,raw=false) {
    const response=await fetcher(new URL(MIRROR_PATH+'/'+action,origin),{method:'POST',headers:{'content-type':'application/json','x-opencraft-mirror-server':config.serverId,authorization:'Bearer '+config.credential},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(action==='file-send'?65000:10000)])});
    if(!response.ok){await response.body?.cancel();throw Error('mirror_unavailable_http_'+response.status);}
    if(!raw)return response.json();
    const chunks=[];let size=0;
    if(!response.body)throw Error('media_unavailable');
    for await(const chunk of response.body){size+=chunk.length;if(size>2097152)throw Error('media_too_large');chunks.push(chunk);}
    return Buffer.concat(chunks,size);
  }
  // Fetch a sent file's original through the Relay; no callback deadline applies here.
  async function downloadFile(source,mediaId,signal,limit=MAX_INBOUND_FILE_BYTES) {
    const response=await fetcher(new URL(MIRROR_PATH+'/file',origin),{method:'POST',headers:{'content-type':'application/json','x-opencraft-mirror-server':config.serverId,authorization:'Bearer '+config.credential},body:JSON.stringify({source,mediaId}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if(!response.ok||!response.body){await response.body?.cancel();throw Object.assign(Error('file_unavailable'),{permanent:[404,410].includes(response.status)});}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('file too large');chunks.push(chunk);}
    return Buffer.concat(chunks,size);
  }
  async function downloadEmotion(source,picUrl,signal) {
    const response=await fetcher(new URL(MIRROR_PATH+'/emotion',origin),{method:'POST',headers:{'content-type':'application/json','x-opencraft-mirror-server':config.serverId,authorization:'Bearer '+config.credential},body:JSON.stringify({source,picUrl}),redirect:'error',signal});
    if(!response.ok||!response.body){await response.body?.cancel();throw Error('Emotion unavailable');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('Emotion too large');chunks.push(chunk);}return Buffer.concat(chunks,size);
  }
  const avatarDirectory=createAvatarDirectorySync({collaboration,profiles:avatarProfiles(deploymentPaths().dataDirectory),corpId:config.corpId,request});
  const groupSync=directoryOnly?null:createGroupSyncPump({call,request,onError,corpId:config.corpId,resolveNativeMembers:group=>resolveNativeMemberIdentities(collaboration,request,config.corpId,group,Date.now,resolveNativeMemberRtx),linkMembers:async(source,snapshot,evidence)=>{await synchronizeRtxMembers(collaboration,source,snapshot,evidence,Date.now,prepareDirectoryIdentity);try{avatarDirectory.observeGroup(source,snapshot,evidence);}catch{/* Presentation failures never block group synchronization. */}}});
  const fileJobs=new Map();
  function pumpFiles() {
    if(stopped||!journal)return;
    for(const {row,file} of journal.pending()) {
      if(fileJobs.size>=2)break;if(fileJobs.has(row.key))continue;
      let permanent=false;
      const source=row.event.source;
      const remaining=file.nested?Math.max(0,40*1024*1024-row.files.filter(f=>f!==file&&f.nested).reduce((sum,f)=>sum+(f.bytes??0),0)):MAX_INBOUND_FILE_BYTES;
      const job=storeInboundFile(file.id,file.name,async s=>{
        try{if(!remaining)throw Error('file too large');return await downloadFile(source,file.mediaId,s,Math.min(remaining,MAX_INBOUND_FILE_BYTES));}catch(error){permanent=error.permanent===true;throw error;}
      },{signal:abort.signal,source}).then(async meta=>{if(!stopped&&meta.original&&!file.nested)await call('join/wecom-file/admit',{source,messageId:row.messageId,externalId:row.event.id,id:file.id});if(!stopped)journal.fileResult(row,file,meta.status,permanent,meta.bytes??0);})
        .catch(()=>{if(!stopped)journal.fileResult(row,file,'unavailable');})
        .finally(()=>fileJobs.delete(row.key));
      fileJobs.set(row.key,job);
    }
  }
  async function tick() {
    let delay=1500,stage='files';
    try {
      pumpFiles();void groupSync?.poll();
      if(!directoryOnly)await migrateLegacyFiles().catch(()=>{migrations.delete(migrations.keys().next().value);});
      stage='link-poll';const {links}=await request('link-poll',{});
      if(!Array.isArray(links)||links.length>8)throw Error('invalid_links');
      for(const link of links) {
        try {
          const result=await call('mirrorLink',{actorId:link.actorId,generation:link.generation,corpId:config.corpId,userId:link.userId});
          await request('link-ack',{id:link.id,linked:result?.linked===true});
        } catch(error) {
          if(error.message==='channel_denied'||error.message==='Identity already belongs to another human')await request('link-ack',{id:link.id,linked:false});
          else throw error;
        }
      }
      stage='native-directory';const humans=await call('mirrorDirectory',{corpId:config.corpId});
      stage='native-sources';const channels=directoryOnly?undefined:await call('mirrorSources',{corpId:config.corpId});
      stage='register';const registered=await request('register',{humans,recording:!directoryOnly,...(!directoryOnly?{streamReplies:true,channels}:{})});
      notificationReadyUntil=registered?.turnNotifications===true?Date.now()+80000:0;
      // Bounded background enrichment never delays message polling or mutates identities.
      void avatarDirectory.refresh(humans,abort.signal).catch(()=>{});
      if(directoryOnly)return;
      stage='poll';const packet=await request('poll',{});
      if(!Array.isArray(packet.deliveries)||packet.deliveries.length>8)throw Error('invalid_deliveries');
      for(const delivery of packet.deliveries) {
        if(stopped)break;
        const {binding,token}=delivery;let {event}=delivery;let leaseTimer;
        try {
          if(binding.serverId!==config.serverId||binding.source!==event.source||typeof token!=='string')throw Error('invalid_delivery');
          deliveries.set(event.source,binding);
          if(event.nestedMedia?.length) {
            await request('lease',{source:event.source,token,id:event.id});
            leaseTimer=setInterval(()=>{void request('lease',{source:event.source,token,id:event.id}).catch(()=>{});},10000);leaseTimer.unref();
          }
          // Redis Lua represents an empty media array as {}; normalize once for every media consumer.
          stage='prepare';const raw=event,media=Array.isArray(raw.nestedMedia)?raw.nestedMedia:[];
          const prepared=await journal.prepare(raw,async()=>{
          // Recovery reads require an initialized native source. A fresh room's first media
          // must reach ChannelSync's authorized binding/ingest path before it can be recovered.
          // Keep errors for known sources (retired groups, identity conflicts) fail-closed.
          const recoverable=(raw.voice||media.length)&&channels.some(channel=>channel.source===raw.source);
          const existing=recoverable?await call('received',{source:raw.source,arrival:{...raw,mentioned:raw.mentioned===true&&raw.assistantEligible===true}}):null;
          if(typeof existing?.text==='string') {
            const {voice,nestedMedia,...rest}=raw;event={...rest,text:existing.text};
          }else{
          event=await resolveNestedMedia(event,{secret:config.credential,download:downloadFile,downloadEmotion,transcribe,
            signal:AbortSignal.any([abort.signal,AbortSignal.timeout(45000)])});
          // The timeline line carries an unguessable id; the file itself is fetched after the ACK.
          // Voice becomes text before the timeline sees it; a slow or unconfigured recognizer keeps "[语音]".
          if(event.voice){const {voice,...rest}=event;event=rest;
            try{
              const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(25000)]);
              const bytes=await downloadFile(event.source,voice.mediaId,signal,MAX_VOICE_BYTES);
              const said=await transcribe(bytes,voice.format,{signal});
              if(said)event={...event,text:(event.text&&event.text!=='[语音]'?event.text+'\n':'')+'[语音] '+said};
            }catch{ if(stopped)throw Error('mirror_closed'); }}
          }
          if(raw.forwardedRecord){
            const record=parseForwardedRecord({...raw.forwardedRecord,resources:media.slice(0,16).map((item,index)=>({path:item.path,id:inboundFileId(config.credential,raw.source,raw.id+':nested:'+index)})),...(event.forwardedRecord?.transcripts?{transcripts:event.forwardedRecord.transcripts}:{})});
            const id=inboundFileId(config.credential,raw.source,raw.id+':chat-record');
            await storeInboundFile(id,record.title+'.chat-record.json',async()=>Buffer.from(JSON.stringify(record)),{source:raw.source,signal:abort.signal});
            const preview=event.text.length>14800?event.text.slice(0,14800)+'\n…（展示预览已截短，原始结构见资料）':event.text;
            event={...event,forwardedRecord:record,text:preview.includes('资料编号 '+id)?preview:inboundFileLine(preview+'\n[聊天记录原始结构]',id)};
          }
          let file;
          if(event.file){const {file:f,...rest}=event;event=rest;
            if(typeof f?.mediaId==='string'&&typeof f.name==='string'){file={...f,id:inboundFileId(config.credential,event.source,event.id)};if(!existing)event={...event,text:inboundFileLine(event.text,file.id)};}}
          const files=file?[file]:[];
          for(const [index,item]of media.slice(0,16).entries()) {
            if(!item||!['file','image'].includes(item.type)||typeof item.mediaId!=='string'||typeof item.name!=='string')continue;
            const id=inboundFileId(config.credential,raw.source,raw.id+':nested:'+index);
            if(event.text.includes('资料编号 '+id))files.push({id,name:item.name,mediaId:item.mediaId,nested:true});
          }
          return {event,files};
          });
          event={...prepared.event,...(raw.mediaId?{mediaId:raw.mediaId}:{})};
          for(const file of prepared.files??[])reserveInboundFileSource(file.id,event.source);
          const inlineImage=event.mediaId?await request('image',{reference:event.mediaId},abort.signal,true):undefined;
          if(!consume)throw Error('mirror_closed');
          stage='native-ingest';const receipt=await consume({...event,mentioned:event.mentioned===true&&event.assistantEligible===true,inlineImage});
          if(typeof receipt?.messageId!=='string'||!receipt.messageId)throw Error('durable_receipt_required');
          await call('join/wecom-sync/adopt-created',{source:event.source,binding}).catch(error=>onError(error,{stage:'group-initialize'}));
          stage='journal-admit';journal.admit(prepared,receipt.messageId);
          stage='ack';await request('ack',{source:event.source,token,id:event.id,messageId:receipt.messageId});
          journal.ack(prepared);pumpFiles();
          delay=0;
        } catch(error) {
          if(!stopped)onError(error,{stage});
          if(!stopped)await request('release',{source:event.source,token}).catch(()=>{});
        } finally { clearInterval(leaseTimer);deliveries.delete(event.source); }
      }
    } catch(error) { if(!stopped)onError(error,{stage}); /* Pending Redis records remain unacknowledged. */ }
    finally { if(!stopped){timer=setTimeout(()=>{job=tick();},delay);timer.unref();} }
  }
  const subscribe=receive=>{
    if(consume||stopped)throw Error('mirror_subscription_unavailable');consume=receive;
    if(groupSync)removeChanges=collaboration.channels?.onChange(change=>{
      if(!stopped&&(change.directory||change.memberActorId))void groupSync.notify(change.channelId);
    });
    job=tick();
    return ()=>{removeChanges?.();removeChanges=undefined;stopped=true;clearTimeout(timer);abort.abort();consume=undefined;};
  };
  const removeReader=directoryOnly?()=>{}:installProviderReader(config.corpId,p=>request('provider-query',p));
  return {
    notifications:createWeComTurnNotifications({actors:collaboration.actors,corpId:config.corpId,resolveRtx:resolveNativeMemberRtx,ready:()=>!stopped&&notificationReadyUntil>Date.now(),deliver:input=>request('turn-notification',input)}),
    bindings,
    async resolveBinding(arrival) {
      const binding=deliveries.get(arrival.source);if(!binding)throw Error('binding_denied');
      return call('mirrorBind',{binding,corpId:config.corpId});
    },
    link(context) {
      if(context.credentialId!==null)throw Error('channel_denied');
      return request('link-start',{actorId:context.actorId,generation:context.generation});
    },
    subscribe,
    subscribeWithReceipt:subscribe,
    files:true,
    async send(message,signal) {
      const action=stagedGroupAction(message.requestId);
      if(['interaction','collection-control','shortcuts','quit-chat','members','task-card','rich-message','custom-shortcuts','rich-card'].includes(action?.kind)) {
        const result=await request('assistant-action',{source:message.source,...action,replyTo:message.replyTo},signal);
        if(result.status==='delivered') {
          if(action.kind==='quit-chat')await call('retireSource',{source:message.source,messageId:message.requestId});
          dropGroupFile(message.requestId);
        }
        if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;
      }
      if(action?.kind==='create-chat'){const result=await request('chat-create',{source:message.source,...action,replyTo:message.replyTo},signal);
        if(result.status==='delivered')dropGroupFile(message.requestId);
        if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;}
      if(action?.kind==='edit-chat'){const result=await request('chat-update',{source:message.source,...action,replyTo:message.replyTo},signal);
        if(result.verification)saveGroupOperationResult(message.requestId,{verification:result.verification});
        if(result.status==='delivered')dropGroupFile(message.requestId);
        if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;}
      if(action?.kind==='report') {
        const result=await request('report',{source:message.source,report:action.report,owner:action.owner,requestId:action.requestId,replyTo:message.replyTo},signal);
        if(result.status==='delivered')dropGroupFile(message.requestId);
        if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;
      }
      const file=message.attachment?{...message.attachment,bytes:Buffer.from(message.attachment.bytes),mode:'file'}:stagedGroupFile(message.requestId);
      const picture=file&&file.mode!=='file'?await nativePicture(file.bytes):null;
      if(file?.mode==='image'&&!picture){if(message.replyTo)await request('presentation-settle',{source:message.source,replyTo:message.replyTo},signal).catch(()=>{});return 'rejected';}
      if(picture) {
        const {mediaId}=await request('image-upload',{type:picture.type,bytes:picture.bytes.toString('base64')},signal);
        const result=await request('image-send',{source:message.source,mediaId,replyTo:message.replyTo},signal);
        if(result.status==='delivered')dropGroupFile(message.requestId);
        return result.status;
      }
      if(file){const result=await request('file-send',{source:message.source,name:file.name,bytes:file.bytes.toString('base64'),replyTo:message.replyTo},signal);
        if(result.status==='delivered')dropGroupFile(message.requestId);
        if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;}
      const result=await request('send',message,signal);if(!['delivered','rejected'].includes(result.status))throw Error('invalid_receipt');return result.status;},
    images:{
      download:(reference,signal)=>request('image',{reference},signal,true),
      upload:async(image,signal)=>(await request('image-upload',{type:image.type,bytes:Buffer.from(image.bytes).toString('base64')},signal)).mediaId,
      attribute:async(message,signal)=>(await request('image-attribute',message,signal)).status,
      send:async(source,mediaId,signal)=>(await request('image-send',{source,mediaId},signal)).status,
    },
    async close(){removeChanges?.();removeChanges=undefined;removeReader();stopped=true;clearTimeout(timer);abort.abort();consume=undefined;await job;await groupSync?.close();await Promise.allSettled([...fileJobs.values()]);await agent?.close();},
  };
}

/** Keeps directory/link ownership at the existing native Actor owner without moving message delivery. */
export async function withWeComDirectory(transport,config,dependencies,fetcher) {
  const directory=await createMirrorTarget(config,dependencies,fetcher,{directoryOnly:true});
  let stop;
  return {...transport,notifications:directory.notifications,link:context=>directory.link(context),
    subscribe(receive) {
      const unsubscribe=transport.subscribe(receive);
      try {stop=directory.subscribe(async()=>{throw Error('Directory-only transport cannot admit messages');});}
      catch(error){unsubscribe();throw error;}
      return ()=>{stop?.();unsubscribe();};
    },
    async close(){stop?.();await Promise.allSettled([directory.close(),transport.close?.()]);},
  };
}
