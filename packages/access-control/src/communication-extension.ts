import type { SqlDatabase } from '@opencraft/sql';
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
  synchronize?(service:Collaboration,db:SqlDatabase,command:{method:string;params:Record<string,any>}):{result:unknown;changes:import('./native-channels.js').NativeChannelChange[]}|undefined;
  /** Presentation only; provider labels cannot grant access or become explicit names. */
  /** Installation declares generic outbound file transport; never grants read/send authority. */
  channelFiles?(source:string):boolean;
  groupDisplayTitle?(service:Collaboration,db:SqlDatabase,id:string):string|null;
  groupMutation?(service:Collaboration,db:SqlDatabase,context:ActorContext,id:string,key:string,change:Record<string,any>):void;
  /** Choices offered in the group creation form. Their submitted values reach groupCreated. */
  groupCreateOptions?:readonly import('@opencraft/appserver-protocol').ChannelGroupCreateOption[];
  /** Queue an external group for a just-created native group, inside the same transaction.
   * options holds every declared groupCreateOptions ID; unsubmitted options are false. */
  groupCreated?(service:Collaboration,db:SqlDatabase,context:ActorContext,id:string,input:{title:string;members:string[];options:Readonly<Record<string,boolean>>}):void;
  /** A verified external sender's local human, for viewer-relative presentation only. */
  senderHuman?(service:Collaboration,db:SqlDatabase,subject:import('./native-channels.js').ChannelExternalSender,scope:import('./native-channels.js').ChannelSenderReadScope):string|null;
  avatar?(service:Collaboration,db:SqlDatabase,subject:import('./native-channels.js').ChannelAvatarSubject,scope:import('./native-channels.js').AvatarReadScope):import('./native-channels.js').ChannelAvatar|null;
  fingerprint?(arrival:Record<string,any>):unknown[];
  arrival?(service:Collaboration,db:SqlDatabase,arrival:Record<string,any>,source:Record<string,any>,messageId:string):void;
  nativeMessage?(service:Collaboration,db:SqlDatabase,context:ActorContext,channelId:string,messageId:string,text:string,target?:string):boolean;
  mentionDelivery?(service:Collaboration,db:SqlDatabase,channelId:string,actorId:string):'native-only'|'linked'|undefined;
  deliveryAllowed?(service:Collaboration,db:SqlDatabase,delivery:Record<string,any>):boolean|undefined;
  /** Installation maps explicit native identities to verified recipients in this source only. */
  outboundMentions?(service:Collaboration,db:SqlDatabase,delivery:Record<string,any>,mentions:import('@opencraft/appserver-protocol').ChannelMention[]):{start:number;end:number;recipient:string}[];
  /** Provider message this queued delivery answers; transports may thread or stream the reply under it. */
  replyTarget?(db:SqlDatabase,messageId:string):string|undefined;
  /** Source-owned display policy after delivery authorization, never inferred from a name. */
  outboundPresentation?(service:Collaboration,db:SqlDatabase,delivery:Record<string,any>):{
    role:import('@opencraft/appserver-protocol').ChannelMessagePresentation['sender']['role'];
    format:import('@opencraft/appserver-protocol').ChannelMessagePresentation['format'];
  }|undefined;
  command?(service:Collaboration,db:SqlDatabase,assistants:PersonalAssistants,context:ActorContext,method:string,params:Record<string,any>):{result:unknown;personalReadGuard?:{epoch:string;groups:{id:string;epoch:string}[]}}|undefined;
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
const EXTENSION_FUNCTIONS=['synchronizeOwner','synchronize','channelFiles','groupDisplayTitle','groupMutation','groupCreated',
  'senderHuman','avatar','fingerprint','arrival','nativeMessage','mentionDelivery','deliveryAllowed','outboundMentions','replyTarget',
  'outboundPresentation','command'] as const satisfies readonly (keyof CommunicationExtension)[];
// Every member is either listed above or groupCreateOptions, so validation keeps up with the interface.
const everyMemberValidated:[Exclude<keyof CommunicationExtension,'groupCreateOptions'|typeof EXTENSION_FUNCTIONS[number]>] extends [never]?true:never=true;
void everyMemberValidated;
/** Rejects anything that is not a communication extension: unknown members,
 * non-function callbacks and malformed group creation options. */
export function validateCommunicationExtension(value:unknown):asserts value is CommunicationExtension {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid communication extension: expected an object');
  for(const [key,member] of Object.entries(value)) {
    if(key==='groupCreateOptions')continue;
    if(!(EXTENSION_FUNCTIONS as readonly string[]).includes(key))throw Error(`Invalid communication extension: unknown member ${key}`);
    if(member!==undefined&&typeof member!=='function')throw Error(`Invalid communication extension: ${key} must be a function`);
  }
  validateGroupCreateOptions((value as CommunicationExtension).groupCreateOptions);
}
let composed=false;
/** Import-time installation, kept for existing entries. Reinstalling the same
 * value is a no-op; it never replaces a different or composition-owned extension. */
export function installCommunicationExtension(value:CommunicationExtension,url?:string) {
  if(composed)throw Error('Communication extension already installed by server composition');
  if(extension&&extension!==value)throw Error('Communication extension already installed');
  validateGroupCreateOptions(value.groupCreateOptions);
  extension=value;moduleURL=url;
}
/** Server composition installation: exclusive for one server lifetime. The module
 * URL is re-imported by storage Workers, so it must export `communicationExtension`.
 * Returns the release used after that server has closed its storage owners. */
export function claimCommunicationExtension(value:unknown,url:string):()=>void {
  validateCommunicationExtension(value);
  if(typeof url!=='string'||!URL.canParse(url))throw Error('Invalid communication extension module URL');
  if(extension)throw Error(extension===value
    ?'Communication extension already installed; install it once, either through server composition or by import'
    :'A different communication extension is already installed');
  extension=value;moduleURL=url;composed=true;
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    if(extension===value&&composed){extension=undefined;moduleURL=undefined;composed=false;}
  };
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
