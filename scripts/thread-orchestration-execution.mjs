import { randomUUID } from 'node:crypto';
import { callConversationHost } from './conversation-execution.mjs';

/** In-process trusted Hub composition; none of this context is wire decoded. */
export function createThreadOrchestrationExecution(getAppHost) {
  const invoke=(method,threadId,operationId,params={},canAdmit=()=>true)=>{
    const host=getAppHost();if(!host)throw new Error('Orchestration Host unavailable');
    return callConversationHost(host,{hostId:'local-codex',threadId},operationId,method,{operationId,...params},
      {sender:null,orchestrationOperationId:operationId,orchestrationCanAdmit:canAdmit});
  };
  return {
    prepare:(operationId,threadId,args,canAdmit,callbackIncarnation)=>invoke('opencraft/orchestration/prepare',threadId,operationId,{arguments:args,callbackIncarnation},canAdmit),
    create:(operationId,threadId,settings,canAdmit)=>invoke('opencraft/orchestration/create',threadId,operationId,{settings},canAdmit),
    acknowledge:async operationId=>(await invoke('opencraft/orchestration/ack','',operationId)).acknowledged===true,
    snapshot:threadId=>invoke('opencraft/orchestration/status',threadId,`status:${randomUUID()}`),
    inspect:(threadId,limit)=>invoke('opencraft/orchestration/inspect',threadId,`inspect:${randomUUID()}`,{limit}),
  };
}
