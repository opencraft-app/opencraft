import type {ConversationRef} from './collaboration';
export const MESSAGE_ATTACHMENT_SOURCE='opencraft-message-attachments' as const;
export const MESSAGE_ATTACHMENT_PAGE_BYTES=32768;
export const MESSAGE_ATTACHMENT_MAX_PAGE=50;
export interface MessageAttachmentQuery {clientMessageId?:string;cursor?:string;limit?:number}
export interface MessageAttachmentMetadata {
 clientMessageId:string;id:string;name:string;mimeType:string;declaredSize:number;
 kind:'host-file'|'object-url';contentAvailable:'unknown';
}
export interface ConversationMessageAttachments {
 ref:ConversationRef;source:typeof MESSAGE_ATTACHMENT_SOURCE;observedAt:number;consistency:'live-pages';
 entries:MessageAttachmentMetadata[];nextCursor:string|null;complete:boolean;
}
const bytes=(v:string)=>new TextEncoder().encode(v).length;
export function metadataText(v:unknown,max:number):string {
 if(typeof v!=='string'||!v.length||v.length>max||bytes(v)>max||/[\x00-\x1f\x7f]/u.test(v))throw Error('Invalid attachment metadata');return v;
}
export function parseMessageAttachmentQuery(value:unknown):MessageAttachmentQuery {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid attachment query');const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['clientMessageId','cursor','limit'].includes(k)))throw Error('Invalid attachment query');
 const q:MessageAttachmentQuery={};if(v.clientMessageId!==undefined)q.clientMessageId=metadataText(v.clientMessageId,512);
 if(v.cursor!==undefined)q.cursor=metadataText(v.cursor,4096);
 if(v.limit!==undefined){if(!Number.isInteger(v.limit)||Number(v.limit)<1||Number(v.limit)>MESSAGE_ATTACHMENT_MAX_PAGE)throw Error('Invalid attachment limit');q.limit=Number(v.limit);}return q;
}
/** Fresh, narrow projection also protects callers from a non-equivalent Host. */
export function projectMessageAttachmentPage(value:unknown,ref:ConversationRef):ConversationMessageAttachments {
 const v=value as ConversationMessageAttachments;
 if(!v||v.ref?.serverId!==ref.serverId||v.ref?.threadId!==ref.threadId||v.source!==MESSAGE_ATTACHMENT_SOURCE||v.consistency!=='live-pages'
  ||!Number.isSafeInteger(v.observedAt)||!Array.isArray(v.entries)||v.entries.length>MESSAGE_ATTACHMENT_MAX_PAGE
  ||!(v.nextCursor===null||typeof v.nextCursor==='string')||v.complete!==(v.nextCursor===null))throw Error('Invalid attachment page');
 const entries=v.entries.map(row=>{
  if(!row||!Number.isSafeInteger(row.declaredSize)||row.declaredSize<0||!['host-file','object-url'].includes(row.kind)||row.contentAvailable!=='unknown')throw Error('Invalid attachment metadata');
  return {clientMessageId:metadataText(row.clientMessageId,512),id:metadataText(row.id,512),name:metadataText(row.name,1024),mimeType:metadataText(row.mimeType,256),declaredSize:row.declaredSize,kind:row.kind,contentAvailable:'unknown' as const};
 });
 const result:ConversationMessageAttachments={ref:{serverId:ref.serverId,threadId:ref.threadId},source:MESSAGE_ATTACHMENT_SOURCE,observedAt:v.observedAt,consistency:'live-pages',entries,nextCursor:v.nextCursor===null?null:metadataText(v.nextCursor,4096),complete:v.complete};
 if(bytes(JSON.stringify(result))>MESSAGE_ATTACHMENT_PAGE_BYTES)throw Error('Attachment page budget exceeded');return result;
}
