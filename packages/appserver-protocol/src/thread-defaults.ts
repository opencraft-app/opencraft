import {parseConversationSettings} from './conversation-settings';
import type {ConversationRef} from './collaboration';
export const THREAD_DEFAULTS_SCOPE = 'subsequent-native-turns-including-already-accepted';
export const THREAD_DEFAULTS_CAPABILITY = 'opencraft/thread-defaults';
export const THREAD_DEFAULTS_WRITE = 'opencraft/thread-defaults/update';
export const THREAD_DEFAULTS_READ = 'opencraft/thread-defaults/read';
export interface ThreadDefaultsBundle {
  permissionMode:'read-only'|'accept-edits'|'full'; mode:'plan'|'default'; model:string; reasoningEffort:string;
}
export interface ThreadDefaultsObservation {
  ref:ConversationRef; scope:'thread-current-or-last-persisted'; source:'native/thread/read'|'unknown'; observedAt:number;
  model:string|null; reasoningEffort:string|null; mode:'plan'|'default'|null; permissionProfileId:string|null;
  approvalPolicy:string|null; actualTurnSettings:null;
}
export interface ThreadDefaultsResult {
  ref:ConversationRef; scope:typeof THREAD_DEFAULTS_SCOPE;
  includesAlreadyAcceptedInputs:true; includesOtherParticipantsInputs:true;
  requested:ThreadDefaultsBundle; requestState:'acknowledged'|'unknown';
  observation:ThreadDefaultsObservation; actualTurnSettings:null;
}
export function parseThreadDefaults(value:unknown):ThreadDefaultsBundle {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_thread_defaults');
  const r=value as Record<string,unknown>;
  if(Object.keys(r).some(k=>!['permissionMode','mode','model','reasoningEffort'].includes(k))
    ||typeof r.permissionMode!=='string'||typeof r.mode!=='string'||!['read-only','accept-edits','full'].includes(String(r.permissionMode))||!['plan','default'].includes(String(r.mode)))throw Error('invalid_thread_defaults');
  const settings=parseConversationSettings({model:r.model,reasoningEffort:r.reasoningEffort});
  return {permissionMode:r.permissionMode as ThreadDefaultsBundle['permissionMode'],mode:r.mode as ThreadDefaultsBundle['mode'],model:settings.model!,reasoningEffort:settings.reasoningEffort!};
}
export function unknownThreadDefaults(ref:ConversationRef):ThreadDefaultsObservation {
  return {ref,scope:'thread-current-or-last-persisted',source:'unknown',observedAt:Date.now(),model:null,reasoningEffort:null,mode:null,permissionProfileId:null,approvalPolicy:null,actualTurnSettings:null};
}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const field=(v:unknown):string|null=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x20\x7f]/u.test(v)?v:null;
/** A strict independent Native read, never the submitted bundle or viewer cache. */
export function observeThreadDefaults(ref:ConversationRef,value:unknown):ThreadDefaultsObservation {
  const r=object(object(value).thread);if(r.id!==ref.threadId)throw Error('thread_defaults_observation_unavailable');
  const mode=object(r.collaborationMode).mode;
  return {...unknownThreadDefaults(ref),source:'native/thread/read',model:field(r.model),reasoningEffort:field(r.reasoningEffort),
    mode:mode==='plan'||mode==='default'?mode:null,permissionProfileId:field(object(r.activePermissionProfile).id),
    approvalPolicy:['never','on-request','on-failure','untrusted'].includes(String(r.approvalPolicy))?String(r.approvalPolicy):null};
}
