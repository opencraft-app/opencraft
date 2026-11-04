import {encodeConversationRef,type ConversationRef} from '@opencraft/appserver-protocol/collaboration';
import {createWorkbenchThreadLocation} from '@opencraft/workbench-runtime';

/** Resolve connection-local routes using authority and metadata, never URI path
 * guesses or message bodies. The canonical Server remains the authority. */
export async function resolveConversationReferenceNavigation(ref:ConversationRef,hosts:readonly string[],
  request:(hostId:string,method:'opencraft/collaboration'|'thread/read',params:Record<string,unknown>)=>Promise<Record<string,unknown>>) {
  for(const hostId of [...new Set(hosts)].slice(0,32)) {
    try {
      const resolved=await request(hostId,'opencraft/collaboration',{action:'reference',threadId:ref.threadId});
      if(encodeConversationRef(resolved.ref as ConversationRef)!==encodeConversationRef(ref))continue;
      const metadata=await request(hostId,'thread/read',{threadId:ref.threadId,includeTurns:false});
      if((metadata.thread as {id?:string}|undefined)?.id!==ref.threadId)continue;
      return createWorkbenchThreadLocation(hostId,ref.threadId);
    } catch { /* Another configured connection may own this canonical resource. */ }
  }
  throw new Error('Conversation Server unavailable');
}
