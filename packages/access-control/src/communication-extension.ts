import type { DatabaseSync } from 'node:sqlite';
import type { Collaboration } from './collaboration.js';
import type { PersonalAssistants } from './personal-assistants.js';
import type { ActorContext } from '@opencraft/identity-core/actors';

/** Trusted installation composition only. No client-selected modules or provider
 * semantics. Storage callbacks execute inside the communication transaction;
 * synchronizeOwner runs on the live Actor owner before Worker dispatch. */
export interface CommunicationExtension {
  /** Trusted transport only, never client RPC. Use the live Actor owner for identity
   * mutations so authorization projections publish with committed bindings.
   * undefined continues ordinary storage dispatch; an envelope handles the call. */
  synchronizeOwner?(service:Collaboration,command:{method:string;params:Record<string,any>}):{result:unknown}|undefined;
  /** Installation-owned metadata replication. Never reachable from client-selected sync RPCs. */
  synchronize?(service:Collaboration,db:DatabaseSync,command:{method:string;params:Record<string,any>}):{result:unknown;changes:import('./native-channels.js').NativeChannelChange[]}|undefined;
  /** Presentation only; provider labels cannot grant access or become explicit names. */
  /** Installation declares generic outbound file transport; never grants read/send authority. */
  channelFiles?(source:string):boolean;
  groupDisplayTitle?(service:Collaboration,db:DatabaseSync,id:string):string|null;
  groupMutation?(service:Collaboration,db:DatabaseSync,context:ActorContext,id:string,key:string,change:Record<string,any>):void;
  /** Choices offered in the group creation form. Their submitted values reach groupCreated. */
  groupCreateOptions?:readonly import('@opencraft/appserver-protocol').ChannelGroupCreateOption[];
  /** Queue an external group for a just-created native group, inside the same transaction.
   * options holds every declared groupCreateOptions ID; unsubmitted options are false. */
  groupCreated?(service:Collaboration,db:DatabaseSync,context:ActorContext,id:string,input:{title:string;members:string[];options:Readonly<Record<string,boolean>>}):void;
  /** A verified external sender's local human, for viewer-relative presentation only. */
  senderHuman?(service:Collaboration,db:DatabaseSync,subject:import('./native-channels.js').ChannelExternalSender,scope:import('./native-channels.js').ChannelSenderReadScope):string|null;
  avatar?(service:Collaboration,db:DatabaseSync,subject:import('./native-channels.js').ChannelAvatarSubject,scope:import('./native-channels.js').AvatarReadScope):import('./native-channels.js').ChannelAvatar|null;
  fingerprint?(arrival:Record<string,any>):unknown[];
  arrival?(service:Collaboration,db:DatabaseSync,arrival:Record<string,any>,source:Record<string,any>,messageId:string):void;
  nativeMessage?(service:Collaboration,db:DatabaseSync,context:ActorContext,channelId:string,messageId:string,text:string,target?:string):boolean;
  mentionDelivery?(service:Collaboration,db:DatabaseSync,channelId:string,actorId:string):'native-only'|'linked'|undefined;
  deliveryAllowed?(service:Collaboration,db:DatabaseSync,delivery:Record<string,any>):boolean|undefined;
  /** Installation maps explicit native identities to verified recipients in this source only. */
  outboundMentions?(service:Collaboration,db:DatabaseSync,delivery:Record<string,any>,mentions:import('@opencraft/appserver-protocol').ChannelMention[]):{start:number;end:number;recipient:string}[];
  /** Provider message this queued delivery answers; transports may thread or stream the reply under it. */
  replyTarget?(db:DatabaseSync,messageId:string):string|undefined;
  /** Source-owned display policy after delivery authorization, never inferred from a name. */
  outboundPresentation?(service:Collaboration,db:DatabaseSync,delivery:Record<string,any>):{
    role:import('@opencraft/appserver-protocol').ChannelMessagePresentation['sender']['role'];
    format:import('@opencraft/appserver-protocol').ChannelMessagePresentation['format'];
  }|undefined;
  command?(service:Collaboration,db:DatabaseSync,assistants:PersonalAssistants,context:ActorContext,method:string,params:Record<string,any>):{result:unknown;personalReadGuard?:{epoch:string;groups:{id:string;epoch:string}[]}}|undefined;
}
let extension:CommunicationExtension|undefined, moduleURL:string|undefined;
const OPTION_ID=/^[a-z][a-z0-9-]{0,31}$/, MESSAGE_ID=/^[A-Za-z0-9_.-]{1,128}$/;
function validDescriptor(value:unknown) {
  const descriptor=value as {id?:unknown;defaultMessage?:unknown}|null;
  return !!descriptor&&typeof descriptor==='object'&&typeof descriptor.id==='string'&&MESSAGE_ID.test(descriptor.id)
    &&typeof descriptor.defaultMessage==='string'&&descriptor.defaultMessage.length>0&&descriptor.defaultMessage.length<=512;
}
function validateGroupCreateOptions(options:CommunicationExtension['groupCreateOptions']) {
  if(options===undefined)return;
  if(!Array.isArray(options)||options.length>8)throw Error('Invalid group creation options');
  const ids=new Set<string>();
  for(const option of options) {
    if(!option||typeof option.id!=='string'||!OPTION_ID.test(option.id)||ids.has(option.id)||!validDescriptor(option.label)
      ||(option.description!==undefined&&!validDescriptor(option.description))||typeof option.defaultSelected!=='boolean')
      throw Error('Invalid group creation options');
    ids.add(option.id);
  }
}
export function installCommunicationExtension(value:CommunicationExtension,url?:string) {
  if(extension&&extension!==value)throw Error('Communication extension already installed');
  validateGroupCreateOptions(value.groupCreateOptions);
  extension=value;moduleURL=url;
}
/** Declared group creation options, already validated at installation. */
export const groupCreateOptions=()=>extension?.groupCreateOptions??[];
/** Every declared option resolved to a boolean, or undefined when the submission
 * is malformed or names an option this installation does not declare. */
export function groupCreateOptionValues(value:unknown):Record<string,boolean>|undefined {
  const declared=groupCreateOptions();
  if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))return undefined;
  const submitted=(value??{}) as Record<string,unknown>;
  if(Object.entries(submitted).some(([key,selected])=>!declared.some(option=>option.id===key)||typeof selected!=='boolean'))return undefined;
  return Object.fromEntries(declared.map(option=>[option.id,submitted[option.id]===true]));
}
export const communicationExtension=()=>extension;
export const communicationExtensionModule=()=>moduleURL;
