import type { ProjectAutomations } from './automation-runtime.js';
import type { Automation, AutomationRun } from './automation.js';
import type { AutomationGrant } from './automation-ledger.js';
import type { OrchestrationRuntimeStorage } from './orchestration-runtime-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeConversationRef, parseConversationRef } from '@opencraft/appserver-protocol/collaboration';
import { ACTOR_INPUT_PREFIX, Collaboration, CollaborationError } from './collaboration.js';
import type { BoundedThreadDelegation, OrchestrationMessageOrigin } from './orchestration-authority.js';
import { canonical,type ChildOutcome,type ToolOperation } from './orchestration-ledger.js';

export const ORCHESTRATION_TOOL_NAMES = ['thread_spawn','thread_tell','thread_inspect','thread_wait'] as const;
export type OrchestrationRuntimeSnapshot = import("@opencraft/appserver-protocol/collaboration").ThreadOrchestrationSnapshot;
export type OrchestrationExecutionPort = import('@opencraft/appserver-client').AgentDriverContract;
const text=(value:unknown,max=256)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value))throw new CollaborationError(400,'invalid_orchestration_field');return value;
};
const fields=(value:Record<string,unknown>,allowed:readonly string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))throw new CollaborationError(400,'unexpected_orchestration_field');};
const permissionSnapshot=(settings:Record<string,unknown>)=>JSON.stringify(canonical({permissions:settings.permissions,sandbox:settings.sandbox,approvalPolicy:settings.approvalPolicy,approvalsReviewer:settings.approvalsReviewer,runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots,config:settings.config,cwd:settings.cwd}));
const terminal=new Set(['completed','failed','exhausted','unconfirmed','interrupted_by_user']);

/** Hub coordination over the collaboration ledger and existing Host input queue. */
export class ThreadOrchestrationBroker {
  automations?: ProjectAutomations;
  /** Record the already-created child in its source collaboration scope before delivery. */
  childScope?: (parent:import('@opencraft/appserver-protocol/collaboration').ConversationRef,child:import('@opencraft/appserver-protocol/collaboration').ConversationRef)=>Promise<void>;
  legacySchedule?: (threadId:string)=>Promise<{status:string}|null>;
  private readonly calls=new Map<string,{fingerprint:string;promise:Promise<unknown>}>();
  private readonly operationCalls=new Map<string,Promise<unknown>>();
  private ackSweep:Promise<void>|null=null;
  private reconciledStartup=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private sweep:Promise<void>|null=null;
  private closed=false;
  private reportedSweepFailure=false;
  private readonly observations=new Set<Promise<void>>();
  constructor(readonly collaboration:Collaboration,private readonly execution:OrchestrationExecutionPort,private readonly now=Date.now,private readonly runtimeStorage:OrchestrationRuntimeStorage){}
  start():void {if(!this.timer&&!this.closed){this.timer=setInterval(()=>{void this.reconcile().then(()=>{this.reportedSweepFailure=false;},()=>{if(!this.reportedSweepFailure){this.reportedSweepFailure=true;console.warn('[opencraft orchestration]',JSON.stringify({event:'orchestration-sweep-failed'}));}});},500);this.timer.unref();}}
  get available():boolean{return !this.closed;}
  stop():void{this.closed=true;if(this.timer)clearInterval(this.timer);}
  async close():Promise<void>{this.stop();await this.sweep?.catch(()=>{});await this.ackSweep?.catch(()=>{});await Promise.allSettled([...this.observations]);await Promise.allSettled([...this.calls.values()].map(call=>call.promise));}
  async invoke(threadId:string,turnId:string,toolCallKey:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    if(this.closed)return Promise.reject(new CollaborationError(503,'orchestration_closed'));
    text(threadId);text(turnId);text(toolCallKey,1024);
    const authority=this.collaboration.delegation(threadId,turnId,delegationId);
    if(this.automations){const scope=await this.automations.checkDelegation(authority.id);if(scope.derived)throw new CollaborationError(403,'automation_thread_mutation_denied');}
    const fingerprint=JSON.stringify(canonical([threadId,turnId,name,args,delegationId,callbackIncarnation])),prior=this.calls.get(toolCallKey);
    if(prior)return prior.fingerprint===fingerprint?prior.promise:Promise.reject(new CollaborationError(409,'orchestration_call_changed'));
    const call=this.perform(threadId,turnId,toolCallKey,name,args,delegationId,callbackIncarnation).finally(()=>{if(this.calls.get(toolCallKey)?.promise===call)this.calls.delete(toolCallKey);});
    this.calls.set(toolCallKey,{fingerprint,promise:call});return call;
  }
  private authorize(delegation:BoundedThreadDelegation,target:string,action:string):void{
    if(!this.collaboration.conversationAllowed(delegation.context,this.reference(target),action))throw new CollaborationError(403,'conversation_action_denied');
  }
  private reference(threadId:string){return {serverId:this.collaboration.execution.serverForThread?.(threadId)??this.collaboration.execution.serverId!,threadId};}
  private valid(delegation:BoundedThreadDelegation,turnId:string):boolean{
    try{return !this.closed&&this.collaboration.delegation(delegation.sourceThreadId,turnId,delegation.id).id===delegation.id;}catch{return false;}
  }
  private origin(delegation:BoundedThreadDelegation,operation:ToolOperation,inputId:string,turnId:string,replyExpectation:'required'|'none'='required'):OrchestrationMessageOrigin{
    return {kind:'agent',clientMessageId:inputId,authorActorId:null,delegatorActorId:delegation.context.actorId,delegationId:delegation.id,
      senderConversation:this.reference(delegation.sourceThreadId),senderTurnId:turnId,operationId:operation.operationId,
      replyExpectation,delegationRevision:delegation.context.generation,usageSourceKind:'system',createdAtMs:this.now()};
  }
  listChildren(threadId: string, turnId: string, args: Record<string,unknown>, delegationId?: string) {
    fields(args,['threadId','cursor','limit']);
    const delegation=this.collaboration.delegation(threadId,turnId,delegationId),parent=args.threadId===undefined?threadId:text(args.threadId);
    this.authorize(delegation,parent,'conversation.read');
    const limit=args.limit??20;
    if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100)throw new CollaborationError(400,'invalid_child_limit');
    let after=0;
    if(args.cursor!==undefined){
      try{const cursor=JSON.parse(Buffer.from(text(args.cursor,2048),'base64url').toString());
        if(cursor.parent!==parent||!Number.isSafeInteger(cursor.after)||cursor.after<0)throw Error();after=cursor.after;
      }catch{throw new CollaborationError(400,'invalid_child_cursor');}
    }
    const rows=this.collaboration.orchestration.children(parent,after,Number(limit)+1),page=rows.slice(0,Number(limit));
    const children=page.filter(row=>this.collaboration.conversationAllowed(delegation.context,
      {serverId:String(row.server_id),threadId:String(row.thread_id)},'conversation.read')).map(row=>{
      const ref={serverId:String(row.server_id),threadId:String(row.thread_id)},runtime=this.collaboration.orchestration.runtimeSnapshot(ref.threadId);
      return {reference:encodeConversationRef(ref),threadId:ref.threadId,parentThreadId:parent,driver:String(row.driver_kind),
        visibility:String(row.visibility),state:runtime?.state??String(row.runtime_status),hasDirectUserInput:row.has_direct_user_input===1,observedAt:Number(row.updated_at_ms)};
    });
    return {parentReference:encodeConversationRef(this.reference(parent)),children,
      nextCursor:rows.length>Number(limit)?Buffer.from(JSON.stringify({parent,after:Number(page.at(-1)!.cursor)})).toString('base64url'):null};
  }
  async cli(session: {serverId:string;threadId:string;execution?:{inputId?:string;turnId?:string}}, request: Record<string,unknown>) {
    fields(request,['command','arguments','idempotencyKey']);
    if(session.serverId!==this.reference(session.threadId).serverId||!session.execution)throw new CollaborationError(403,'execution_delegation_required');
    const {turnId,delegation}=this.collaboration.executionSource(session.threadId,session.execution);
    this.authorize(delegation,session.threadId,'conversation.read');
    if(this.automations && !(await this.automations.checkDelegation(delegation.id)).valid)throw new CollaborationError(403,'automation_grant_revoked');
    const args=request.arguments??{};
    if(!args||typeof args!=='object'||Array.isArray(args))throw new CollaborationError(400,'invalid_cli_arguments');
    const input=args as Record<string,unknown>,command=text(request.command);
    if(command.startsWith('automation.')) {
      if(!this.automations)throw new CollaborationError(503,'automation_unavailable');
      return this.automations.command({context:delegation.context,authorityId:delegation.id},command.slice('automation.'.length),input,request.idempotencyKey);
    }
    if(command==='context'){
      fields(input,[]);
      const parent=this.collaboration.orchestration.relation(session.threadId)?.parentThreadId;
      return {reference:encodeConversationRef(this.reference(session.threadId)),parentReference:parent&&this.collaboration.conversationAllowed(delegation.context,this.reference(parent),'conversation.read')?encodeConversationRef(this.reference(parent)):null,
        expiresAt:delegation.expiresAtMs};
    }
    if(command==='list')return this.listChildren(session.threadId,turnId,input,delegation.id);
    if(command==='operation') {
      fields(input,['id']);
      const operation=this.collaboration.orchestration.operationById(text(input.id));
      if(!operation || operation.senderThreadId!==session.threadId || operation.delegationId!==delegation.id)
        throw new CollaborationError(404,'operation_unavailable');
      if(operation.targetThreadId)this.authorize(delegation,operation.targetThreadId,'conversation.read');
      return operation;
    }
    if(command==='input') {
      fields(input,['id']);
      const operation=this.collaboration.orchestration.operationById(text(input.id));
      if(!operation || operation.senderThreadId!==session.threadId || operation.delegationId!==delegation.id || !operation.clientMessageId || !operation.targetThreadId)
        throw new CollaborationError(404,'input_unavailable');
      this.authorize(delegation,operation.targetThreadId,'conversation.read');
      if(operation.kind==='spawn')return {operationId:operation.operationId,threadId:operation.targetThreadId,
        inputId:operation.clientMessageId,admission:operation.state,delivery:(operation.result as {delivery?:unknown}|null)?.delivery??null,
        contextEvidence:null};
      return this.collaboration.conversationDelivery(delegation.context,this.reference(operation.targetThreadId),
        operation.clientMessageId.replace(/^actor-input:/u,''));
    }
    if(command==='output') {
      fields(input,['reference','cursor']);
      const result=await this.collaboration.readConversation(delegation.context,input.reference,input.cursor===undefined?null:text(input.cursor,2048));
      this.collaboration.executionSource(session.threadId,session.execution);
      return result;
    }
    if(this.automations && (await this.automations.checkDelegation(delegation.id)).derived)throw new CollaborationError(403,'automation_thread_mutation_denied');
    const names:Record<string,string>={spawn:'thread_spawn',tell:'thread_tell',show:'thread_inspect',wait:'thread_wait'};
    const name=names[command];if(!name)throw new CollaborationError(400,'unknown_thread_command');
    const key=request.idempotencyKey===undefined?null:text(request.idempotencyKey,128);
    if(['spawn','tell'].includes(command)&&!key)throw new CollaborationError(400,'idempotency_key_required');
    const target=(value:unknown)=>{
      const ref=parseConversationRef(text(value,2048));
      if(!ref||ref.serverId!==this.reference(ref.threadId).serverId)throw new CollaborationError(400,'invalid_reference');return ref.threadId;
    };
    const mapped={...input};
    if(command==='tell') {
      const delivery=mapped.delivery??'queue';delete mapped.delivery;
      if(!['native','queue','interrupt'].includes(String(delivery)))throw new CollaborationError(400,'invalid_delivery');
      // Interruption requires an atomic stop/send owner; never emulate it with queue.
      if(delivery==='interrupt')throw new CollaborationError(409,'unsupported_delivery');
      mapped.mode=delivery==='native'?'steer':'queue';
    }
    if(command==='show'||command==='tell'){mapped.threadId=target(mapped.reference);delete mapped.reference;}
    if(command==='wait'){
      if(!Array.isArray(mapped.references))throw new CollaborationError(400,'invalid_wait_targets');
      mapped.threadIds=mapped.references.map(target);delete mapped.references;
    }
    if(key)mapped.idempotencyKey=key;
    return this.invoke(session.threadId,turnId,JSON.stringify(['cli',delegation.id,command,key??randomUUID()]),name,mapped,delegation.id);
  }
  async prepareAutomation(grant:AutomationGrant,context:BoundedThreadDelegation['context']):Promise<string> {
    const target=grant.target;
    if(target.kind==='script')throw new CollaborationError(503,'script_requires_host_authority');
    const threadId=target.kind==='once'?target.sourceThreadId:target.threadId;
    const ref={serverId:grant.serverId,threadId};
    for(const action of ['conversation.read','execution.delegate','message.send','execution.queue'])
      if(!this.collaboration.conversationAllowed(context,ref,action))throw new CollaborationError(403,'automation_resource_denied');
    const metadata=await this.collaboration.execution.metadata?.(ref);
    if(!metadata || metadata.projectId!==grant.projectId || target.environment!==(this.collaboration.execution.hostForServer?.(grant.serverId)??this.collaboration.execution.hostId))
      throw new CollaborationError(403,'automation_project_environment_mismatch');
    if(target.kind==='cron'){
      if(!this.legacySchedule)throw new CollaborationError(503,'legacy_schedule_inspection_unavailable');
      const legacy=await this.legacySchedule(threadId);
      if(legacy && !['deleted','completed'].includes(legacy.status))throw new CollaborationError(409,'legacy_schedule_conflict');
    }
    if(!this.execution.prepare)throw new CollaborationError(503,'automation_permission_inspection_unavailable');
    const settings=await this.execution.prepare('automation-validate:'+grant.id,threadId,target.kind==='once'?{driver:target.driver,model:target.model,reasoningEffort:target.reasoning}: {},()=>this.collaboration.conversationAllowed(context,ref,'execution.delegate'));
    const profile=settings.permissions??settings.sandbox;
    if(profile!==grant.permissionProfile)throw new CollaborationError(403,'automation_permission_profile_mismatch');
    const snapshot=permissionSnapshot(settings);
    if(grant.permissionSnapshot && snapshot!==grant.permissionSnapshot)throw new CollaborationError(403,'automation_permissions_changed');
    return snapshot;
  }
  async dispatchAutomation(value:Automation,run:AutomationRun,grant:AutomationGrant,delegation:BoundedThreadDelegation):Promise<{state:'running';result:unknown}> {
    const target=value.target;
    if(target.kind==='script')throw new CollaborationError(400,'invalid_agent_target');
    let threadId:string,inputId:string;
    if(target.kind==='once') {
      const result=await this.perform(target.sourceThreadId,'automation-control',run.key,'thread_spawn',{
        prompt:target.prompt,driver:target.driver,model:target.model,...(target.reasoning?{reasoningEffort:target.reasoning}:{}),idempotencyKey:run.key},delegation.id) as {operationId:string;threadId:string};
      const operation=this.collaboration.orchestration.operationById(result.operationId)!;
      threadId=result.threadId;inputId=operation.clientMessageId!;
    } else {
      threadId=target.threadId;
      const storage=this.runtimeStorage as OrchestrationRuntimeStorage & {automation(operation:string,input:unknown,now:number):Promise<any>};
      const sent=await storage.automation('enqueue',{key:run.key,id:delegation.id,threadId},this.now());
      inputId=sent.inputId;
      void this.collaboration.pump().catch(()=>{});
    }
    return {state:'running',result:{serverId:grant.serverId,threadId,inputId,context:delegation.context}};
  }
  async inspectAutomation(run:AutomationRun):Promise<{state:'running'|'completed'|'failed'|'unknown';result?:unknown}> {
    const storage=this.runtimeStorage as OrchestrationRuntimeStorage & {automation(operation:string,input:unknown,now:number):Promise<any>};
    const grant=await storage.automation('runGrant',{key:run.key},this.now());
    const context={actorId:grant.actorId,generation:grant.generation,credentialId:null,expiresAt:this.now()+60_000};
    let binding=run.result as {serverId:string;threadId:string;inputId:string};
    if(!binding?.inputId){
      if(grant.target.kind==='once'){
        const operation=this.collaboration.orchestration.operation(run.key);
        if(!operation?.targetThreadId||!operation.clientMessageId)return {state:'unknown'};
        const authority=await storage.automation('checkDelegation',{id:operation.delegationId},this.now());
        if(!authority.derived||authority.runKey!==run.key)return {state:'unknown'};
        binding={serverId:grant.serverId,threadId:operation.targetThreadId,inputId:operation.clientMessageId};
      }else if(grant.target.kind==='cron'){
        const lookup=this.collaboration.lookupConversation(context,{serverId:grant.serverId,threadId:grant.target.threadId},run.key);
        if(!lookup.found)return {state:'unknown'};
        const origin=this.collaboration.inputOrigin(grant.target.threadId,ACTOR_INPUT_PREFIX+lookup.receipt.requestId);
        if(origin?.kind!=='system'||origin.operationId!==run.key||!origin.delegationId)return {state:'unknown'};
        const authority=await storage.automation('checkDelegation',{id:origin.delegationId},this.now());
        if(!authority.derived||authority.runKey!==run.key)return {state:'unknown'};
        binding={serverId:grant.serverId,threadId:grant.target.threadId,inputId:ACTOR_INPUT_PREFIX+lookup.receipt.requestId};
      }else return {state:'unknown'};
    }
    const delivery=this.collaboration.conversationDelivery(context,{serverId:binding.serverId,threadId:binding.threadId},binding.inputId.replace(/^actor-input:/u,''));
    if(delivery.deliveryState==='unknown')return {state:'unknown',result:binding};
    if(['rejected','cancelled'].includes(delivery.deliveryState))return {state:'failed',result:binding};
    if(!delivery.targetTurnId)return {state:'running',result:binding};
    const snapshot=await this.execution.snapshot(binding.threadId);
    if(snapshot.turnId!==delivery.targetTurnId && snapshot.rootTurnId!==delivery.targetTurnId)return {state:'unknown',result:binding};
    if(snapshot.state==='completed')return {state:'completed',result:binding};
    if(['failed','error','interrupted_by_user','exhausted'].includes(snapshot.state))return {state:'failed',result:binding};
    return {state:'running',result:binding};
  }
  private async perform(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    if(['read_thread','send_message_to_thread','get_thread_delivery'].includes(name))return this.conversationTool(threadId,turnId,key,name,args,delegationId);
    if(!ORCHESTRATION_TOOL_NAMES.includes(name as typeof ORCHESTRATION_TOOL_NAMES[number]))throw new CollaborationError(400,'unknown_orchestration_tool');
    const delegation=this.collaboration.delegation(threadId,turnId,delegationId),ledger=this.collaboration.orchestration;
    let target:string|null=null,mode='read';
    if(name==='thread_spawn'){
      fields(args,['title','prompt','parentSelf','bindLifecycleToSelf','visibility','driver','model','reasoningEffort','cwd','idempotencyKey']);text(args.prompt,16384);
      for(const field of ['title','model','reasoningEffort','cwd'])if(args[field]!==undefined)text(args[field],field==='cwd'?4096:256);
      if(args.driver!==undefined&&!['codex','pi','dsh','acp','claude-code'].includes(String(args.driver)))throw new CollaborationError(400,'orchestration_driver_unsupported');
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
      if(args.children===true){
        fields(args,['children','threadId','cursor','limit','idempotencyKey']);
        const {children:_children,idempotencyKey:_key,...query}=args;return this.listChildren(threadId,turnId,query,delegation.id);
      }
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
      const scope=await this.automations?.checkDelegation(delegation.id);
      if(scope){
        if(!scope.valid || scope.grant && permissionSnapshot(settings)!==scope.grant.permissionSnapshot)throw new CollaborationError(403,'automation_permissions_changed');
      }
      const created=await this.execution.create(operation.operationId,threadId,settings,()=>this.valid(delegation,turnId));
      if('rejected' in created){
        ledger.transaction(()=>{ledger.finish(key,{orchestrationFailure:{status:created.rejected.status}},'failed');this.collaboration.queueOrchestrationAck(operation.operationId);});
        void this.reconcileAcks();throw new CollaborationError(created.rejected.status,'native_child_creation_rejected');
      }
      const childId=text(created.threadId),parent=ledger.relation(threadId);
      await this.childScope?.(this.reference(threadId),this.reference(childId));
      ledger.transaction(()=>{
        ledger.createThread({threadId:childId,serverId:this.reference(childId).serverId,driverKind:created.driverKind??String(settings.driver??args.driver??'codex'),ownerActorId:delegation.context.actorId,parentThreadId:threadId,
          lifecycleOwnerThreadId:threadId,forkedFromId:null,visibility:args.visibility==='visible'?'visible':'hidden',engineHostGeneration:created.generationId??null,nativeSessionId:childId,
          runtimeStatus:'starting',rootTurnId:null,turnId:null,delegationRevision:delegation.context.generation,autoExchangeDepth:(parent?.autoExchangeDepth??0)+1,hasDirectUserInput:false,userInputExcerpt:null});
        if(!this.valid(delegation,turnId)){
          ledger.runtime(childId,{runtimeStatus:'error',rootTurnId:null,turnId:null});
          ledger.finish(key,{orchestrationFailure:{status:403}},'failed',childId);this.collaboration.queueOrchestrationAck(operation.operationId);return;
        }
        const sent=this.collaboration.sendConversation(delegation.context,{reference:this.reference(childId),content:args.prompt,
          idempotencyKey:`spawn:${operation.operationId}`,execution:{mode:'queue'}},this.reference(threadId),delegation.id,false,scope?.grant?key:undefined);
        const inputId=ACTOR_INPUT_PREFIX+sent.requestId;
        this.collaboration.authorizeChild(delegation,childId,inputId);
        if(!scope?.grant)this.collaboration.recordInputOrigin(childId,inputId,this.origin(delegation,operation,inputId,turnId));
        ledger.finish(key,{operationId:operation.operationId,threadId:childId,status:'starting',durability:created.durability??'pending_first_turn',delivery:'sent'},'completed',childId,inputId);
        this.collaboration.queueOrchestrationAck(operation.operationId);
      });
      void this.reconcileAcks();void this.collaboration.pump().catch(()=>{});
      return this.receipt(ledger.operation(key)!);
    }
    if(name==='thread_tell'){
      ledger.transaction(()=>{
        const sent=this.collaboration.sendConversation(delegation.context,{reference:this.reference(target!),content:args.message,
          idempotencyKey:`tell:${operation.operationId}`,execution:{mode,...(mode==='steer'?{expectedTurnId:args.expectedTurnId}:{})}},this.reference(threadId),delegation.id);
        const inputId=ACTOR_INPUT_PREFIX+sent.requestId;
        this.collaboration.recordInputOrigin(target!,inputId,this.origin(delegation,operation,inputId,turnId,args.replyExpectation==='none'?'none':'required'));
        ledger.finish(key,{operationId:operation.operationId,threadId:target,delivery:'queued',waitingOn:'turn_starting',delegationRevision:delegation.context.generation},'queued',target,inputId);
      });
      void this.collaboration.pump().catch(()=>{});return ledger.operation(key)!.result;
    }
    if(name==='thread_inspect'){
      const read=this.execution.inspect?{history:await this.execution.inspect(target!,Number(args.includeRecentTurns??1))}:await this.collaboration.readConversation(delegation.context,this.reference(target!));
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
      const query=Promise.all(ticket.targetThreadIds.map(id=>this.execution.snapshot(id))).then(async states=>{if(!this.closed)await Promise.all(states.map(state=>this.observe(state)));return states;}).catch(()=>null);
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
      if(!ref||ref.serverId!==this.reference(ref.threadId).serverId)throw new CollaborationError(400,'invalid_reference');
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
    return this.ackSweep??=(async()=>{for(const id of await this.runtimeStorage.pendingAcks()){
      try{if(await this.execution.acknowledge!(id)!==false){await this.runtimeStorage.acknowledge(id);}}catch{/* Durable intent remains for the next sweep. */}
    }})().finally(()=>{this.ackSweep=null;});
  }
  observe(snapshot:OrchestrationRuntimeSnapshot):Promise<void>{
    if(this.closed)return Promise.resolve();
    const operation=this.runtimeStorage.observe(snapshot,this.now());this.observations.add(operation);
    void operation.then(()=>this.observations.delete(operation),()=>this.observations.delete(operation));
    return operation;
  }
  reconcile():Promise<void>{if(this.closed)return Promise.resolve();return this.sweep??=this.runSweep().finally(()=>{this.sweep=null;});}
  private async runSweep():Promise<void>{
    void this.reconcileAcks();
    const ledger=this.collaboration.orchestration;
    const targets=new Set(await this.runtimeStorage.targets(!this.reconciledStartup,this.now()));
    const snapshots=new Map<string,OrchestrationRuntimeSnapshot>();
    for(const id of targets){let state:OrchestrationRuntimeSnapshot;try{state=await this.execution.snapshot(id);}catch{continue;}if(this.closed)return;await this.observe(state);if(this.closed)return;snapshots.set(id,state);}
    this.reconciledStartup=true;
    const work=await this.runtimeStorage.work(this.now());
    if(this.closed)return;
    for(const ticket of work.waits){
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
    for(const batch of work.notifications){
      const delegation=this.collaboration.notificationDelegation(batch.childThreadId,batch.batchId);if(!delegation)continue;
      try{this.authorize(delegation,batch.childThreadId,'conversation.read');}catch{continue;}
      const key=JSON.stringify([batch.parentThreadId,delegation.id]),group=parents.get(key)??{parent:batch.parentThreadId,delegation,batches:[]};group.batches.push(batch);parents.set(key,group);
    }
    for(const {parent,delegation,batches} of parents.values()){
      if(this.closed)return;
      const ids=batches.map(batch=>batch.batchId).sort(),key=createHash('sha256').update(JSON.stringify(ids)).digest('hex');
      const body=batches.map(batch=>`Child ${encodeConversationRef(this.reference(batch.childThreadId))}: ${batch.outcomeKind}.${batch.hasDirectUserInput?' Direct user input occurred; user instructions take precedence.':''}${batch.userInputExcerpt?'\nUser context: '+batch.userInputExcerpt:''}\n${JSON.stringify(batch.summary)}`).join('\n');
      try{
        ledger.transaction(()=>{
          const sent=this.collaboration.sendConversation(delegation.context,{reference:this.reference(parent),content:body.slice(0,16384),
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
