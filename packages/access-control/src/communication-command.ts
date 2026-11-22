import { receiveChannelAttachment } from './channel-attachment-upload.js';
import { communicationExtension, groupCreateOptionValues } from './communication-extension.js';
import { AssistantThreadStore } from './assistant-thread-store.js';
import { PersonalAssistants } from './personal-assistants.js';
import type { Actor } from '@opencraft/identity-core/actors';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext } from '@opencraft/identity-core/actors';
import { sqliteTransaction } from '@opencraft/sqlite-node';
import type { Collaboration } from './collaboration.js';
import type { NativeChannelChange } from './native-channels.js';
import { syncActorInbox } from './actor-inbox-projection.js';

export interface CommunicationCommand { context: ActorContext; method: string; params: Record<string, unknown>; executionScope?:{serverId:string;hostId:string} }
export interface CommunicationResult { retiredCredentials?:string[]; result: unknown; changes: NativeChannelChange[]; personalReadGuard?: {epoch:string;groups:{id:string;epoch:string}[]}; createdActors?: Actor[]; createdCredential?: {id:string;actor_id:string;generation:number;expires_at:number;enabled:1} }
function invalid(): never { throw Object.assign(Error('invalid_input'), {status:400,code:'invalid_input'}); }
function fields(p: Record<string,unknown>, allowed: string[]) { if (!p || Array.isArray(p) || Object.keys(p).some(k=>!allowed.includes(k))) invalid(); }
function text(value: unknown): string { if(typeof value!=='string'||!value||value.length>2048)invalid();return value; }
/** One transactional command surface for HTTP and AppServer. No socket, engine,
 * or UI dependency. Execution intents use durable bindings, never call a Host. */
export function communicationCommand(service: Collaboration, db: DatabaseSync, command: CommunicationCommand): CommunicationResult {
  const changes: NativeChannelChange[] = [];
  const createdActors: Actor[] = [];
  let personalReadGuard: CommunicationResult["personalReadGuard"];
  let createdCredential: CommunicationResult["createdCredential"];
  const unwatch=service.channels.onChange(change=>changes.push(change));
  try {
    const result=sqliteTransaction(db,()=>{
      const {context:c,method,params:p}=command;
      if(!service.available||!service.actors.isCurrent(c))throw Object.assign(Error('actor_authentication_required'),{status:401,code:'actor_authentication_required'});
      if(!service.admittedActor(c.actorId))throw Object.assign(Error('channel_denied'),{status:403,code:'channel_denied'});
      if(method.startsWith('assistant-thread/'))return new AssistantThreadStore(service,db).command(c,method.slice('assistant-thread/'.length),p);
      const assistants=new PersonalAssistants(service,db);
      const extension=communicationExtension()?.command?.(service,db,assistants,c,method,p);
      if(extension){personalReadGuard=extension.personalReadGuard;return extension.result;}
      if(method==='personal-assistant/model-authority'){fields(p,['botId']);return assistants.modelAuthority(c,p.botId);}
      if(method==='personal-assistant/model-set')return assistants.setModel(c,p);
      if(method==='personal-assistant/check-groups')return assistants.checkGroups(c,p as NonNullable<CommunicationResult['personalReadGuard']>);
      if(method==='personal-assistant/provision') {
        fields(p,['botId']);const result=assistants.provision(c,p.botId);
        createdCredential={id:result.credential.credentialId,actor_id:result.assistant.actorId,
          generation:service.actors.get(result.assistant.actorId)!.generation,expires_at:result.credential.expiresAt,enabled:1};
        return result;
      }
      if(method==='personal-assistant/own-messages')return assistants.ownMessages(c,p);
      if(method==='personal-assistant/attachment')return assistants.attachment(c,p);
      if(method==='personal-assistant/reply')return assistants.reply(c,p);
      if(method==='personal-assistant/read-authority'){fields(p,[]);return assistants.readAuthority(c);}
      if(method==='personal-assistant/finish')return assistants.finish(c,p);
      if(method.startsWith('opencraft/personal-assistant/')) {
        const result=assistants.command(c,method,p,createdActors);
        personalReadGuard=assistants.groupGuard(c,method,p,result);
        return result;
      }
      switch(method){
        // Public installations without an external sync adapter have no sync attributes.
        case 'opencraft/channels/group/sync/status':fields(p,['channelId']);service.channels.assertReadable(c,text(p.channelId));return null;
        case 'opencraft/channels/people/list':fields(p,['after','query']);return service.channels.people(c,p.query===undefined?'':text(p.query),p.after===undefined?'':text(p.after));
        case 'opencraft/channels/list': fields(p,[]);return {groups:service.channels.list(c)};
        case 'opencraft/channels/direct/open': fields(p,['actorId']);return service.openChannelDirect(c,p.actorId);
        case 'opencraft/crew/teams':fields(p,[]);return {teams:service.crew.teams(c)};
        case 'opencraft/crew/phonebook/list':fields(p,['botId']);return service.crew.view(c,p.botId);
        case 'opencraft/crew/phonebook/set':fields(p,['botId','actorId','present']);service.crew.setPhonebook(c,p.botId,p.actorId,p.present);return service.crew.view(c,p.botId);
        case 'opencraft/crew/work/dispatch':return service.crewDispatch(c,p);
        case 'opencraft/crew/work/message':return service.crewMessage(c,p);
        case 'opencraft/crew/work/start':fields(p,[]);return {work:service.crewWork.start(c)};
        case 'opencraft/crew/work/finish':fields(p,['workId']);return {work:service.crewWork.finish(c,p.workId)};
        case 'opencraft/crew/work/get':fields(p,['workId']);return {work:service.crewWork.view(c,p.workId)};
        case 'opencraft/crew/work/list':fields(p,[]);return {works:service.crewWork.list(c)};
        case 'opencraft/crew/work/replies':fields(p,['after']);return {replies:service.crewWork.replies(c,p.after)};
        case 'opencraft/crew/work/attachment':fields(p,['workId','offset']);return {file:service.crewWork.attachmentChunk(c,p.workId,p.offset)};
        case 'crew/desk-authority':fields(p,['actorId']);return service.crewWork.deskAuthority(c,p.actorId);
        case 'opencraft/crew/work/inbox':fields(p,[]);return {items:service.crewWork.inbox(c)};
        case 'opencraft/channels/group/get':fields(p,['channelId']);return service.channels.getGroup(c,text(p.channelId));
        case 'opencraft/channels/group/list-state/set':fields(p,['channelId','hidden','clientRequestId']);return service.setChannelListHidden(c,text(p.channelId),p.hidden,p.clientRequestId);
        case 'opencraft/channels/group/leave':fields(p,['channelId','clientRequestId']);service.leaveChannelGroup(c,text(p.channelId),p.clientRequestId);return null;
        case 'opencraft/channels/group/dissolve':fields(p,['channelId','expectedRevision','clientRequestId']);return service.dissolveChannelGroup(c,text(p.channelId),p.expectedRevision,p.clientRequestId);
        case 'opencraft/channels/group/create':{fields(p,['title','memberActorIds','clientRequestId','options']);
          // Installation options are resolved before the transaction; the hook runs only for a newly created group.
          const options=groupCreateOptionValues(p.options),created=communicationExtension()?.groupCreated;if(!options)invalid();
          return service.createChannelGroup(c,p.title,p.memberActorIds,p.clientRequestId,created&&((id,input)=>created(service,db,c,id,{...input,options})));}
        case 'opencraft/channels/group/member/set':fields(p,['channelId','actorId','present','clientRequestId']);service.setChannelMember(c,text(p.channelId),p.actorId,p.present,p.clientRequestId);return null;
        case 'opencraft/channels/group/rename':fields(p,['channelId','title','clientRequestId']);return service.renameChannelGroup(c,text(p.channelId),p.title,p.clientRequestId);
        case 'opencraft/channels/group/members/list':fields(p,['channelId']);return {members:service.channelMembers(c,text(p.channelId))};
        case 'opencraft/channels/group/candidates/search':fields(p,['query','channelId']);if(typeof p.query!=='string'||p.query.length>128)invalid();return {candidates:service.channels.inviteCandidates(c,p.query,p.channelId===undefined?undefined:text(p.channelId))};
        case 'opencraft/channels/messages/around':fields(p,['channelId','sequence']);return service.channels.around(c,text(p.channelId),p.sequence);
        case 'opencraft/channels/search':fields(p,['query','before','limit']);return service.channels.searchAll(c,p.query,p.before,p.limit);
        case 'opencraft/channels/messages/search':fields(p,['channelId','query','before','limit']);return service.channels.search(c,text(p.channelId),p.query,p.before,p.limit);
        case 'opencraft/channels/messages/list':fields(p,['channelId','before']);return service.channels.history(c,text(p.channelId),p.before===undefined?undefined:Number(p.before));
        case 'opencraft/channels/sync':fields(p,['channelId','cursor']);return service.channels.sync(c,text(p.channelId),p.cursor===undefined?undefined:text(p.cursor));
        case 'opencraft/channels/mentions/ack':fields(p,['channelId','messageId']);return service.channels.acknowledgeMention(c,text(p.channelId),text(p.messageId));
        case 'opencraft/channels/read':fields(p,['channelId','throughSequence']);if(typeof p.throughSequence!=='number')invalid();service.channels.markRead(c,text(p.channelId),p.throughSequence);return null;
        case 'opencraft/channels/attachments/upload':
          fields(p,['channelId','clientMessageId','name','type','text','total','offset','base64']);return receiveChannelAttachment(service,c,p);
        case 'opencraft/channels/attachments/send': {
          fields(p,['channelId','clientMessageId','name','type','base64','text']);
          if(typeof p.base64!=='string'||p.base64.length>11184812)invalid();
          if(Buffer.from(p.base64,'base64').toString('base64')!==p.base64)invalid();
          const bytes=Buffer.from(p.base64,'base64'),channelId=text(p.channelId);
          return {receipt:service.sendAttachment(c,channelId,p.clientMessageId,{name:p.name as string,type:p.type as string,bytes},p.text)};
        }
        case 'opencraft/channels/attachments/read':
          fields(p,['channelId','sequence','offset']);return service.channels.attachmentChunk(c,text(p.channelId),Number(p.sequence),Number(p.offset));
        case 'opencraft/channels/attachments/get': {
          fields(p,['channelId','sequence']);const id=text(p.channelId),sequence=Number(p.sequence);
          const file=service.channels.attachment(c,id,sequence);
          if(file)return {name:file.name,type:file.type,base64:Buffer.from(file.bytes as Uint8Array).toString('base64')};
          const image=service.channels.image(c,id,sequence);
          return image?{name:'image',type:image.type,base64:Buffer.from(image.bytes as Uint8Array).toString('base64')}:null;
        }
        case 'channel/image': {
          fields(p,['channelId','sequence']);
          return service.channels.image(c,text(p.channelId),Number(p.sequence));
        }
        case 'channel/image/send': {
          fields(p,['channelId','clientMessageId','type','bytes']);
          return {receipt:service.sendChannel(c,text(p.channelId),p.clientMessageId,'',undefined,undefined,{type:p.type as 'image/png'|'image/jpeg',bytes:p.bytes as Uint8Array})};
        }
        case 'opencraft/channels/messages/send': {
          fields(p,['channelId','clientMessageId','parts','replyToMessageId','wakeActorIds','mentions']);
          if(!Array.isArray(p.parts)||p.parts.length!==1)invalid();const part=p.parts[0];
          if(!part||typeof part!=='object')invalid();fields(part,['type','text']);if(part.type!=='text')invalid();
          return {receipt:service.sendChannel(c,text(p.channelId),p.clientMessageId,part.text,p.replyToMessageId,p.wakeActorIds,undefined,p.mentions)};
        }
        case 'opencraft/channels/delivery/get':fields(p,['channelId','clientMessageId']);return {receipt:service.channelDelivery(c,text(p.channelId),p.clientMessageId)};
        case 'channel/readable':fields(p,['channelId']);return service.channels.assertReadable(c,text(p.channelId));
        case 'inbox/sync':fields(p,['cursor','limit']);return syncActorInbox(db,{actorId:c.actorId,generation:c.generation,cursor:p.cursor===undefined?undefined:text(p.cursor),limit:p.limit===undefined?50:Number(p.limit)});
        case 'send':return service.send(c,p);
        case 'inbox':fields(p,['after','limit']);return service.inbox(c,Number(p.after),Number(p.limit));
        case 'messages':fields(p,['peerActorId','after','limit']);return service.messages(c,text(p.peerActorId),Number(p.after),Number(p.limit));
        case 'read':fields(p,['messageId']);service.read(c,text(p.messageId));return null;
        default:throw Error('method_not_found');
      }
    });
    const retiredCredentials=(result as any)?.retiredCredentials as string[]|undefined;
    if(retiredCredentials)delete (result as any).retiredCredentials;
    return {result,changes,createdActors,createdCredential,personalReadGuard,retiredCredentials};
  } finally { unwatch(); }
}
