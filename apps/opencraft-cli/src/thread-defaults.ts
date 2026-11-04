import {THREAD_DEFAULTS_SCOPE,unknownThreadDefaults,type ConversationRef,type ThreadDefaultsBundle,type ThreadDefaultsResult} from '@opencraft/appserver-protocol/collaboration';
import type {CollaborationClient} from '@opencraft/appserver-client/collaboration';
import {CliError,classify} from './errors';
/** One attempt; a read can observe current state but cannot reconcile a durable operation. */
export async function setThreadDefaults(client:CollaborationClient,ref:ConversationRef,bundle:ThreadDefaultsBundle) {
 let result:ThreadDefaultsResult;
 try{result=await client.setThreadDefaults(ref,THREAD_DEFAULTS_SCOPE,bundle);}
 catch(error){const fault=classify(error);if(![7,8].includes(fault.exitCode))throw error;
  throw new CliError(7,'THREAD_DEFAULTS_OUTCOME_UNKNOWN','Use thread defaults <same-ref> --observe-only. Never replay this write.',false,
    {ref,scope:THREAD_DEFAULTS_SCOPE,requested:bundle,requestState:'unknown',includesAlreadyAcceptedInputs:true,includesOtherParticipantsInputs:true,observation:unknownThreadDefaults(ref),actualTurnSettings:null});}
 if(result.requestState==='unknown')throw new CliError(7,'THREAD_DEFAULTS_OUTCOME_UNKNOWN','Submission is unknown. Observe current defaults without replay; ACK is not saved or Turn evidence.',false,result);
 return result;
}
