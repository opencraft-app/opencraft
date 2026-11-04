import type { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import { type ConversationCreateTarget, type ConversationCreation } from '@opencraft/appserver-protocol/collaboration';
import { conversationUiLink } from './links';
import type { SendInput } from './send';
import { CliError, classify } from './errors';

export function creationLink(operation: ConversationCreation, webUrl?: string) {
  return {...operation, uiLink:conversationUiLink(webUrl,operation.ref)};
}
/** Exactly one mutation; all subsequent accounting is read-only, even unknown. */
export async function createConversation(client: CollaborationClient, target: ConversationCreateTarget, input: SendInput, webUrl?: string) {
  if(input.settings)client.require('modelSettings');
  client.require('create'); client.require('createLookup');
  let operation: ConversationCreation | undefined;
  const details = () => ({operationKey:input.operationKey,...target,...(operation ? {operation:creationLink(operation,webUrl)} : {})});
  const check = () => {
    if (operation!.creationState==='rejected' || operation!.firstMessageState==='rejected' || ['rejected','cancelled'].includes(operation!.firstMessage?.deliveryState ?? ''))
      throw new CliError(8,'CREATION_REJECTED','Creation or first input rejected.',false,details());
    if (operation!.creationState==='unknown' || operation!.firstMessageState==='unknown')
      throw new CliError(7,'OUTCOME_UNKNOWN','Outcome unknown. Use lookup.',true,details());
  };
  try {
    operation = await client.create(target,input.content,input.operationKey,input.settings);
    check();
    if (input.timeoutMs===null) return creationLink(operation,webUrl);
    const deadline = performance.now()+input.timeoutMs;
    while (performance.now()<deadline) {
      if (['submitted','injected'].includes(operation.firstMessage?.deliveryState ?? '')) return creationLink(operation,webUrl);
      const lookup = await client.lookupCreation(target.serverId,input.operationKey,Math.max(1,Math.min(15000,deadline-performance.now())));
      if (lookup.found) operation=lookup.operation;
      check();
      if (['submitted','injected'].includes(operation.firstMessage?.deliveryState ?? '')) return creationLink(operation,webUrl);
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(0,deadline-performance.now()))));
    }
    throw new CliError(7,'DELIVERY_TIMEOUT','First-input wait timed out.',true,details());
  } catch (error) {
    const fault=classify(error);
    if (fault.exitCode!==7) throw fault;
    throw new CliError(7,fault.code==='DELIVERY_TIMEOUT'?fault.code:'OUTCOME_UNKNOWN','Use read-only lookup with the original key.',true,details());
  }
}
