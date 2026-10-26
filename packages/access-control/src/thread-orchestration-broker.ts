import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeConversationRef, parseConversationRef } from '@opencraft/appserver-protocol/collaboration';
import { ACTOR_INPUT_PREFIX, Collaboration, CollaborationError } from './collaboration.js';
import type { BoundedThreadDelegation, OrchestrationMessageOrigin } from './orchestration-authority.js';
import type { ChildOutcome, ThreadRelation, ToolOperation } from './orchestration-ledger.js';

export const ORCHESTRATION_TOOL_NAMES = ['thread_spawn','thread_tell','thread_inspect','thread_wait'] as const;
export type OrchestrationRuntimeSnapshot = import("@opencraft/appserver-protocol/collaboration").ThreadOrchestrationSnapshot;
export interface OrchestrationExecutionPort {
  /** The Engine Host reconciles this operation id; a gateway must never retry an ordinary native create. */
  prepare?(operationId:string,sourceThreadId:string,args:Record<string,unknown>,canAdmit:()=>boolean,callbackIncarnation?:string):Promise<Record<string,unknown>>;
  inspect?(threadId:string,limit:number):Promise<{entries:Array<{turnId:string;role:string;text:string}>}>;
  create(operationId: string,sourceThreadId: string,args: Record<string,unknown>,canAdmit:()=>boolean): Promise<{threadId:string;generationId?:string;durability?:'immediate'|'pending_first_turn'}|{rejected:{status:number}}>;
  snapshot(threadId: string): Promise<OrchestrationRuntimeSnapshot>;
  acknowledge?(operationId: string): Promise<boolean|void>;
}
const text=(value:unknown,max=256)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value))throw new CollaborationError(400,'invalid_orchestration_field');return value;
};
const fields=(value:Record<string,unknown>,allowed:readonly string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))throw new CollaborationError(400,'unexpected_orchestration_field');};
const terminal=new Set(['completed','failed','exhausted','unconfirmed','interrupted_by_user']);

/** Hub coordination over the collaboration ledger and existing Host input queue. */
export class ThreadOrchestrationBroker {
  private readonly calls=new Map<string,{fingerprint:string;promise:Promise<unknown>}>();
  private readonly operationCalls=new Map<string,Promise<unknown>>();
  private ackSweep:Promise<void>|null=null;
  private reconciledStartup=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private sweep:Promise<void>|null=null;
  private closed=false;
  constructor(readonly collaboration:Collaboration,private readonly execution:OrchestrationExecutionPort,private readonly now=Date.now){}
  start():void {if(!this.timer&&!this.closed){this.timer=setInterval(()=>{void this.reconcile().catch(()=>{});},500);this.timer.unref();}}
  get available():boolean{return !this.closed;}
  stop():void{this.closed=true;if(this.timer)clearInterval(this.timer);}
  async close():Promise<void>{this.stop();await this.sweep?.catch(()=>{});await this.ackSweep?.catch(()=>{});await Promise.allSettled([...this.calls.values()].map(call=>call.promise));}
  async invoke(threadId:string,turnId:string,toolCallKey:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    if(this.closed)return Promise.reject(new CollaborationError(503,'orchestration_closed'));
    text(threadId);text(turnId);text(toolCallKey,1024);
    this.collaboration.delegation(threadId,turnId,delegationId);
    const fingerprint=JSON.stringify([threadId,turnId,name,args,delegationId,callbackIncarnation]),prior=this.calls.get(toolCallKey);
    if(prior)return prior.fingerprint===fingerprint?prior.promise:Promise.reject(new CollaborationError(409,'orchestration_call_changed'));
    const call=this.perform(threadId,turnId,toolCallKey,name,args,delegationId,callbackIncarnation).finally(()=>{if(this.calls.get(toolCallKey)?.promise===call)this.calls.delete(toolCallKey);});
    this.calls.set(toolCallKey,{fingerprint,promise:call});return call;
  }
  private authorize(delegation:BoundedThreadDelegation,target:string,action:string):void{
    if(!this.collaboration.conversationAllowed(delegation.context,{serverId:this.collaboration.execution.serverId!,threadId:target},action))throw new CollaborationError(403,'conversation_action_denied');
  }
  private valid(delegation:BoundedThreadDelegation,turnId:string):boolean{
    try{return !this.closed&&this.collaboration.delegation(delegation.sourceThreadId,turnId,delegation.id).id===delegation.id;}catch{return false;}
  }
  private origin(delegation:BoundedThreadDelegation,operation:ToolOperation,inputId:string,turnId:string,replyExpectation:'required'|'none'='required'):OrchestrationMessageOrigin{
    return {kind:'agent',clientMessageId:inputId,authorActorId:null,delegatorActorId:delegation.context.actorId,delegationId:delegation.id,
      senderConversation:{serverId:this.collaboration.execution.serverId!,threadId:delegation.sourceThreadId},senderTurnId:turnId,operationId:operation.operationId,
      replyExpectation,delegationRevision:delegation.context.generation,usageSourceKind:'system',createdAtMs:this.now()};
  }
  private async perform(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    if(['read_thread','send_message_to_thread','get_thread_delivery'].includes(name))return this.conversationTool(threadId,turnId,key,name,args,delegationId);
    if(!ORCHESTRATION_TOOL_NAMES.includes(name as typeof ORCHESTRATION_TOOL_NAMES[number]))throw new CollaborationError(400,'unknown_orchestration_tool');
    const delegation=this.collaboration.delegation(threadId,turnId,delegationId),ledger=this.collaboration.orchestration;
    let target:string|null=null,mode='read';
    if(name==='thread_spawn'){
      fields(args,['title','prompt','parentSelf','bindLifecycleToSelf','visibility','driver','model','reasoningEffort','cwd','idempotencyKey']);text(args.prompt,16384);
      for(const field of ['title','model','reasoningEffort','cwd'])if(args[field]!==undefined)text(args[field],field==='cwd'?4096:256);
      if(args.driver!==undefined&&args.driver!=='codex')throw new CollaborationError(400,'orchestration_driver_unsupported');
      if(args.parentSelf!==undefined&&args.parentSelf!==true||args.bindLifecycleToSelf!==undefined&&args.bindLifecycleToSelf!==true)throw new CollaborationError(400,'invalid_parent_binding');
      if(args.visibility!==undefined&&!['visible','hidden'].includes(String(args.visibility)))throw new CollaborationError(400,'invalid_thread_visibility');
      this.authorize(delegation,threadId,'execution.delegate');mode='start';
    }else if(name==='thread_tell'){
      fields(args,['threadId','message','mode','expectedTurnId','replyExpectation','idempotencyKey']);target=text(args.threadId);text(args.message,16384);mode=args.mode===undefined?'queue':text(args.mode);
      if(!['queue','steer'].includes(mode)||mode==='steer'&&!args.expectedTurnId||mode==='queue'&&args.expectedTurnId!==undefined)throw new CollaborationError(400,'invalid_execution_mode');
      if(args.expectedTurnId!==undefined)text(args.expectedTurnId);
      if(args.replyExpectation!==undefined&&!['required','none'].includes(String(args.replyExpectation)))throw new CollaborationError(400,'invalid_reply_expectation');
      this.authorize(delegation,target,'message.send');this.authorize(delegation,target,'execution.'+mode);
      if(target===threadId)throw new CollaborationError(409,'self_delivery_denied');
    }else if(name==='thread_inspect'){
      fields(args,['threadId','includeRecentTurns','idempotencyKey']);target=text(args.threadId);this.authorize(delegation,target,'conversation.read');
      if(args.includeRecentTurns!==undefined&&(!Number.isInteger(args.includeRecentTurns)||Number(args.includeRecentTurns)<1||Number(args.includeRecentTurns)>5))throw new CollaborationError(400,'invalid_recent_turn_limit');
    }else{
      fields(args,['threadIds','waitFor','timeoutMs','idempotencyKey']);
      if(!Array.isArray(args.threadIds)||args.threadIds.length===0||args.threadIds.length>32||new Set(args.threadIds).size!==args.threadIds.length)throw new CollaborationError(400,'invalid_wait_targets');
      for(const id of args.threadIds)this.authorize(delegation,text(id),'conversation.read');
      if(args.waitFor!==undefined&&!['all_settled','any_settled'].includes(String(args.waitFor)))throw new CollaborationError(400,'invalid_wait_condition');
      if(args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||Number(args.timeoutMs)<0||Number(args.timeoutMs)>5000))throw new CollaborationError(400,'invalid_wait_timeout');mode='wait';
    }
    const operation=ledger.accept({toolCallKey:key,delegationId:delegation.id,issuerActorId:delegation.context.actorId,kind:name.slice(7),senderThreadId:threadId,
      targetThreadId:target,clientMessageId:null,mode,arguments:args,...(args.idempotencyKey===undefined?{}:{idempotencyKey:text(args.idempotencyKey,128)})});
    return this.withOperation(operation,async()=>{
    if(name==='thread_spawn'){
      this.collaboration.reserveSpawn(operation.operationId,delegation);
      let settings=this.collaboration.spawnPreparation(operation.operationId);
      if(!settings){const prepared=await this.execution.prepare?.(operation.operationId,threadId,args,()=>this.valid(delegation,turnId),callbackIncarnation)??args;if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');settings=this.collaboration.prepareSpawn(operation.operationId,prepared);}
      const created=await this.execution.create(operation.operationId,threadId,settings,()=>this.valid(delegation,turnId));
      if('rejected' in created){
        ledger.transaction(()=>{ledger.finish(key,{orchestrationFailure:{status:created.rejected.status}},'failed');this.collaboration.queueOrchestrationAck(operation.operationId);});
        void this.reconcileAcks();throw new CollaborationError(created.rejected.status,'native_child_creation_rejected');
      }
      const childId=text(created.threadId),parent=ledger.relation(threadId);
      ledger.transaction(()=>{
        ledger.createThread({threadId:childId,serverId:this.collaboration.execution.serverId!,driverKind:'codex',ownerActorId:delegation.context.actorId,parentThreadId:threadId,
          lifecycleOwnerThreadId:threadId,forkedFromId:null,visibility:args.visibility==='hidden'?'hidden':'visible',engineHostGeneration:created.generationId??null,nativeSessionId:childId,
          runtimeStatus:'starting',rootTurnId:null,turnId:null,delegationRevision:delegation.context.generation,autoExchangeDepth:(parent?.autoExchangeDepth??0)+1,hasDirectUserInput:false,userInputExcerpt:null});
        if(!this.valid(delegation,turnId)){
          ledger.runtime(childId,{runtimeStatus:'error',rootTurnId:null,turnId:null});
          ledger.finish(key,{orchestrationFailure:{status:403}},'failed',childId);this.collaboration.queueOrchestrationAck(operation.operationId);return;
        }
        const sent=this.collaboration.sendConversation(delegation.context,{reference:{serverId:this.collaboration.execution.serverId,threadId:childId},content:args.prompt,
          idempotencyKey:`spawn:${operation.operationId}`,execution:{mode:'queue'}},{serverId:this.collaboration.execution.serverId!,threadId},delegation.id,false);
        const inputId=ACTOR_INPUT_PREFIX+sent.requestId;
        this.collaboration.authorizeChild(delegation,childId,inputId);
        this.collaboration.recordInputOrigin(childId,inputId,this.origin(delegation,operation,inputId,turnId));
        ledger.finish(key,{operationId:operation.operationId,threadId:childId,status:'starting',durability:created.durability??'pending_first_turn',delivery:'sent'},'completed',childId,inputId);
        this.collaboration.queueOrchestrationAck(operation.operationId);
      });
      void this.reconcileAcks();void this.collaboration.pump().catch(()=>{});
      return this.receipt(ledger.operation(key)!);
    }
    if(name==='thread_tell'){
      ledger.transaction(()=>{
        const sent=this.collaboration.sendConversation(delegation.context,{reference:{serverId:this.collaboration.execution.serverId,threadId:target},content:args.message,
          idempotencyKey:`tell:${operation.operationId}`,execution:{mode,...(mode==='steer'?{expectedTurnId:args.expectedTurnId}:{})}},{serverId:this.collaboration.execution.serverId!,threadId},delegation.id);
        const inputId=ACTOR_INPUT_PREFIX+sent.requestId;
        this.collaboration.recordInputOrigin(target!,inputId,this.origin(delegation,operation,inputId,turnId,args.replyExpectation==='none'?'none':'required'));
        ledger.finish(key,{operationId:operation.operationId,threadId:target,delivery:'queued',waitingOn:'turn_starting',delegationRevision:delegation.context.generation},'queued',target,inputId);
      });
      void this.collaboration.pump().catch(()=>{});return ledger.operation(key)!.result;
    }
    if(name==='thread_inspect'){
      const read=this.execution.inspect?{history:await this.execution.inspect(target!,Number(args.includeRecentTurns??1))}:await this.collaboration.readConversation(delegation.context,{serverId:this.collaboration.execution.serverId,threadId:target});
      if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');
      this.authorize(delegation,target!,'conversation.read');
      const history=read.history as {entries?:Array<{turnId:string;role:string;text:string}>;nextCursor?:string|null};
      const turns=[...new Set((history.entries??[]).map(entry=>entry.turnId))].slice(-Number(args.includeRecentTurns??1));
      const entries=(history.entries??[]).filter(entry=>turns.includes(entry.turnId)&&(entry.role==='user'||entry.role==='assistant')).map(entry=>({turnId:entry.turnId,role:entry.role,text:entry.text}));
      const result={threadId:target,entries,nextCursor:history.nextCursor??null,externalContext:true};
      if(Buffer.byteLength(JSON.stringify(result))>24*1024)throw new CollaborationError(502,'conversation_preview_too_large');
      ledger.finish(key,result);return result;
    }
    const ticket=ledger.createWait({waitTicketId:operation.operationId,callerThreadId:threadId,callerTurnId:turnId,targetThreadIds:args.threadIds as string[],
      waitFor:args.waitFor==='any_settled'?'any_settled':'all_settled',expiresAtMs:delegation.expiresAtMs});
    const checkWait=()=>{if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');for(const id of ticket.targetThreadIds)this.authorize(delegation,id,'conversation.read');};
    const deadline=Date.now()+Number(args.timeoutMs??3000);let result:unknown;
    do{
      checkWait();
      const remaining=Math.max(0,deadline-Date.now());
      const query=Promise.all(ticket.targetThreadIds.map(id=>this.execution.snapshot(id))).then(states=>{if(!this.closed)for(const state of states)this.observe(state);return states;}).catch(()=>null);
      const states=remaining===0?null:await Promise.race([query,delay(remaining).then(()=>null)]);
      checkWait();
      if(!states){void query.catch(()=>{});result={settled:false,waitTicketId:ticket.waitTicketId,threads:ticket.targetThreadIds.map(id=>({threadId:id,status:ledger.relation(id)?.runtimeStatus??'unknown'}))};break;}
      const settled=ticket.waitFor==='all_settled'?states.every(state=>terminal.has(state.state)):states.some(state=>terminal.has(state.state));
      if(settled)ledger.settleWait(ticket.waitTicketId,'satisfied');
      result={settled,waitTicketId:ticket.waitTicketId,threads:states};
      if(settled||Date.now()>=deadline||this.closed)break;
      await delay(Math.min(50,Math.max(0,deadline-Date.now())));
    }while(true);
    checkWait();ledger.finish(key,result);return result;
    });
  }
  private async conversationTool(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string):Promise<unknown>{
    const delegation=this.collaboration.delegation(threadId,turnId,delegationId),ledger=this.collaboration.orchestration;
    let target:string|null=null;
    if(name!=='get_thread_delivery'){
      const ref=parseConversationRef(typeof args.reference==='string'?args.reference:'');
      if(!ref||ref.serverId!==this.collaboration.execution.serverId)throw new CollaborationError(400,'invalid_reference');
      target=ref.threadId;this.authorize(delegation,target,name==='read_thread'?'conversation.read':'message.send');
      if(name==='send_message_to_thread')this.authorize(delegation,target,'execution.queue');
    }
    const operation=ledger.accept({toolCallKey:key,delegationId:delegation.id,issuerActorId:delegation.context.actorId,kind:'legacy:'+name,senderThreadId:threadId,
      targetThreadId:target,clientMessageId:null,mode:name==='send_message_to_thread'?'queue':'read',arguments:args});
    return this.withOperation(operation,async()=>{
    const input=name==='send_message_to_thread'?{...args,idempotencyKey:args.idempotencyKey??`legacy:${operation.operationId}`}:args;
    const result=await this.collaboration.tool(threadId,turnId,name,input,delegation.id);
    if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');
    ledger.finish(key,result);return result;
    });
  }
  private receipt(operation:ToolOperation):unknown {
    if(operation.state==='failed')throw new CollaborationError(Number((operation.result as {orchestrationFailure?:{status:number}})?.orchestrationFailure?.status??503),'native_child_creation_rejected');
    return operation.result;
  }
  private withOperation(operation:ToolOperation,run:()=>Promise<unknown>):Promise<unknown>{
    const fresh=this.collaboration.orchestration.operationById(operation.operationId)!;
    if(fresh.result!==null){try{return Promise.resolve(this.receipt(fresh));}catch(error){return Promise.reject(error);}}
    const prior=this.operationCalls.get(operation.operationId);if(prior)return prior;
    const promise=run().finally(()=>{if(this.operationCalls.get(operation.operationId)===promise)this.operationCalls.delete(operation.operationId);});
    this.operationCalls.set(operation.operationId,promise);return promise;
  }
  private reconcileAcks():Promise<void>{
    if(this.closed||!this.execution.acknowledge)return Promise.resolve();
    return this.ackSweep??=(async()=>{for(const id of this.collaboration.pendingOrchestrationAcks()){
      if(this.closed)return;try{if(await this.execution.acknowledge!(id)!==false)this.collaboration.acknowledgeOrchestration(id);}catch{/* Durable intent remains for the next sweep. */}
    }})().finally(()=>{this.ackSweep=null;});
  }
  observe(snapshot:OrchestrationRuntimeSnapshot):void{
    if(this.closed)return;const ledger=this.collaboration.orchestration,child=ledger.relation(snapshot.threadId);if(!child)return;
    const runtimeStatus:ThreadRelation['runtimeStatus']=snapshot.state==='recovering'?'recovering':snapshot.state==='starting'?'starting':snapshot.state==='active'?'active'
      :snapshot.state==='awaiting_interaction'||snapshot.state==='unconfirmed'?'awaiting_interaction':snapshot.state==='completed'?'idle':'error';
    ledger.runtime(child.threadId,{runtimeStatus,rootTurnId:snapshot.rootTurnId,turnId:snapshot.turnId});
    const origin=snapshot.turnId?this.collaboration.turnOrigin(snapshot.threadId,snapshot.turnId):null;
    if(origin?.kind==='user')ledger.directUserInput(child.threadId,origin.userInputExcerpt??null);
    if(snapshot.state==='interrupted_by_user')ledger.directUserInput(child.threadId,null);
    if(!child.parentThreadId||!snapshot.rootTurnId||!terminal.has(snapshot.state)&&snapshot.state!=='awaiting_interaction')return;
    const current=ledger.relation(child.threadId)!;
    ledger.queueNotification({parentThreadId:child.parentThreadId,childThreadId:child.threadId,childRootTurnId:snapshot.rootTurnId,outcomeKind:snapshot.state as ChildOutcome,
      hasDirectUserInput:current.hasDirectUserInput,userInputExcerpt:current.userInputExcerpt,summary:{text:snapshot.summary?.slice(0,4096)??snapshot.state}});
  }
  reconcile():Promise<void>{if(this.closed)return Promise.resolve();return this.sweep??=this.runSweep().finally(()=>{this.sweep=null;});}
  private async runSweep():Promise<void>{
    void this.reconcileAcks();
    const ledger=this.collaboration.orchestration;
    const targets=new Set([...ledger.threads().filter(thread=>!this.reconciledStartup||!['idle','error'].includes(thread.runtimeStatus)).map(thread=>thread.threadId),...ledger.activeWaits().flatMap(ticket=>ticket.targetThreadIds)]);
    const snapshots=new Map<string,OrchestrationRuntimeSnapshot>();
    for(const id of targets){try{const state=await this.execution.snapshot(id);if(this.closed)return;snapshots.set(id,state);this.observe(state);}catch{/* A disconnected owner is not a terminal outcome. */}}
    this.reconciledStartup=true;
    for(const ticket of ledger.activeWaits()){
      const states=ticket.targetThreadIds.map(id=>snapshots.get(id)),settled=ticket.waitFor==='all_settled'?states.every(state=>state&&terminal.has(state.state)):states.some(state=>state&&terminal.has(state.state));
      if(settled){
        const operation=ledger.operationById(ticket.waitTicketId);
        // A live polling call returns its own result; only timed-out subscriptions wake asynchronously.
        if(!operation||operation.result===null&&this.operationCalls.has(operation.operationId))continue;
        let delegation:BoundedThreadDelegation;
        try{delegation=this.collaboration.delegation(ticket.callerThreadId,ticket.callerTurnId,operation.delegationId);for(const id of ticket.targetThreadIds)this.authorize(delegation,id,'conversation.read');}catch{ledger.settleWait(ticket.waitTicketId,'cancelled');continue;}
        ledger.transaction(()=>{
          for(const state of states)if(state&&terminal.has(state.state)){
            const batch=ledger.queueNotification({parentThreadId:ticket.callerThreadId,childThreadId:state.threadId,childRootTurnId:state.rootTurnId??`wait:${ticket.waitTicketId}`,outcomeKind:state.state as ChildOutcome,
              hasDirectUserInput:ledger.relation(state.threadId)?.hasDirectUserInput??false,userInputExcerpt:ledger.relation(state.threadId)?.userInputExcerpt??null,summary:{text:state.summary?.slice(0,4096)??state.state}});
            this.collaboration.notificationAuthority(batch.batchId,delegation.id);
          }
          if(operation.result===null)ledger.finish(operation.toolCallKey,{settled:true,waitTicketId:ticket.waitTicketId,threads:states.filter(Boolean)});
          ledger.settleWait(ticket.waitTicketId,'satisfied');
        });
      }
    }
    const parents=new Map<string,{parent:string;delegation:BoundedThreadDelegation;batches:ReturnType<typeof ledger.dueNotifications>}>();
    for(const batch of ledger.dueNotifications()){
      const delegation=this.collaboration.notificationDelegation(batch.childThreadId,batch.batchId);if(!delegation)continue;
      try{this.authorize(delegation,batch.childThreadId,'conversation.read');}catch{continue;}
      const key=JSON.stringify([batch.parentThreadId,delegation.id]),group=parents.get(key)??{parent:batch.parentThreadId,delegation,batches:[]};group.batches.push(batch);parents.set(key,group);
    }
    for(const {parent,delegation,batches} of parents.values()){
      if(this.closed)return;
      const ids=batches.map(batch=>batch.batchId).sort(),key=createHash('sha256').update(JSON.stringify(ids)).digest('hex');
      const body=batches.map(batch=>`Child ${encodeConversationRef({serverId:this.collaboration.execution.serverId!,threadId:batch.childThreadId})}: ${batch.outcomeKind}.${batch.hasDirectUserInput?' Direct user input occurred; user instructions take precedence.':''}${batch.userInputExcerpt?'\nUser context: '+batch.userInputExcerpt:''}\n${JSON.stringify(batch.summary)}`).join('\n');
      try{
        ledger.transaction(()=>{
          const sent=this.collaboration.sendConversation(delegation.context,{reference:{serverId:this.collaboration.execution.serverId,threadId:parent},content:body.slice(0,16384),
            idempotencyKey:`notice:${key}`,execution:{mode:'queue'}},null,delegation.id,false);
          const inputId=ACTOR_INPUT_PREFIX+sent.requestId,origin=this.origin(delegation,{operationId:`notice:${key}`} as ToolOperation,inputId,batches[0]!.childRootTurnId);
          this.collaboration.recordInputOrigin(parent,inputId,{...origin,kind:'parent_system_notice',replyExpectation:'none',senderConversation:null,senderTurnId:null,childBatchSize:batches.length});
          ledger.markNotificationsDelivered(ids,inputId);
        });
        void this.collaboration.pump().catch(()=>{});
      }catch(error){if(!(error instanceof CollaborationError&&error.status===403))throw error;}
    }
  }
}
