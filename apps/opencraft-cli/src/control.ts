import type { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import type { ConversationRef } from '@opencraft/appserver-protocol/collaboration';
import { CliError, classify } from './errors';
/** No retry, key generation, durable stop claim or write-on-lookup behavior. */
export async function stopThread(client: CollaborationClient, ref: ConversationRef, expectedTurnId: string, observeOnly=false) {
  if (observeOnly) return client.observeStop(ref,expectedTurnId);
  let result;
  try { result=await client.stop(ref,expectedTurnId); }
  catch(error) {
    const fault=classify(error);if (![7,8].includes(fault.exitCode)) throw error;
    throw new CliError(7,'CONTROL_OUTCOME_UNKNOWN','Observe this exact Turn before another control request.',false,{ref,targetTurnId:expectedTurnId,requestState:'unknown',reconcile:'thread stop --expected-turn <same-id> --observe-only'});
  }
  if (result.requestState==='unknown') throw new CliError(7,'CONTROL_OUTCOME_UNKNOWN','Stop submission is unknown; observe the same Turn without replay.',false,result);
  return result;
}
export async function cancelQueue(client: CollaborationClient, ref: ConversationRef, requestId: string) {
  let result;
  try {result=await client.cancelQueue(ref,requestId);}
  catch(error) {
    const fault=classify(error);if (![7,8].includes(fault.exitCode)) throw error;
    throw new CliError(7,'CONTROL_OUTCOME_UNKNOWN','Cancellation is unknown; read the original delivery receipt.',false,{ref,requestId,cancellationState:'unknown',reconcile:'thread show <same-ref> --delivery <same-request>'});
  }
  if (result.cancellationState==='unknown') throw new CliError(7,'CONTROL_OUTCOME_UNKNOWN','Cancellation is unknown; do not replay the control.',false,result);
  return result;
}
