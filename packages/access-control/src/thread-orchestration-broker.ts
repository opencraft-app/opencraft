import { dueOwnerWork, timeoutOwnerWake, type DueOwnerWork, type OwnerWake } from '@opencraft/owner-wake';
import { parseInputCompletion } from "@opencraft/appserver-protocol";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { ThreadAccessStore } from "./thread-access.js";
import { AssistantThreadAuthority } from "./assistant-thread-authority.js";
import { codexPermissionMode } from "@opencraft/appserver-protocol";
import { parseThreadCommand, threadDeliveryIntent } from "@opencraft/appserver-protocol/thread-command";
import type { ProjectAutomations } from './automation-runtime.js';
import type { Automation, AutomationRun } from './automation.js';
import type { AutomationGrant } from './automation-ledger.js';
import type { OrchestrationRuntimeStorage } from './orchestration-runtime-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeConversationRef, parseConversationRef, parseThreadTitle } from '@opencraft/appserver-protocol/collaboration';
import { ACTOR_INPUT_PREFIX, Collaboration, CollaborationError } from './collaboration.js';
import type { BoundedThreadDelegation, OrchestrationMessageOrigin } from './orchestration-authority.js';
import { canonical,type ChildOutcome,type ToolOperation } from './orchestration-ledger.js';

export const ORCHESTRATION_TOOL_NAMES = ['thread_spawn','thread_set_title','thread_tell','thread_inspect','thread_wait'] as const;
export type OrchestrationRuntimeSnapshot = import("@opencraft/appserver-protocol/collaboration").ThreadOrchestrationSnapshot;
export type OrchestrationExecutionPort = import('@opencraft/appserver-client').AgentDriverContract;
const text=(value:unknown,max=256)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value))throw new CollaborationError(400,'invalid_orchestration_field');return value;
};
const fields=(value:Record<string,unknown>,allowed:readonly string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))throw new CollaborationError(400,'unexpected_orchestration_field');};
const assistantRef=(value:unknown)=>{
  const result=parseConversationRef(text(value,2048));
  if(!result)throw new CollaborationError(400,'invalid_reference');
  return result;
};
const permissionSnapshot=(settings:Record<string,unknown>)=>JSON.stringify(canonical({permissions:settings.permissions,sandbox:settings.sandbox,approvalPolicy:settings.approvalPolicy,approvalsReviewer:settings.approvalsReviewer,runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots,config:settings.config,cwd:settings.cwd}));
const terminal=new Set(['completed','failed','exhausted','unconfirmed','interrupted_by_user']);
// Timer sweeps re-read a child only when due: observed changes reset to 500 ms, unchanged ones back
// off to 5 s, and a child stuck in "starting" (no first turn) for 10 min to 15 s. Each status
// read costs a full logical-client lifecycle in the engine, so a fixed 500 ms poll of every
// non-terminal child creates constant background load.
export const ORCHESTRATION_POLL_MIN_MS=500,ORCHESTRATION_POLL_MAX_MS=5_000,ORCHESTRATION_STALE_STARTING_MS=10*60_000,ORCHESTRATION_STALE_STARTING_POLL_MS=15_000;

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
  // The timer sweep wakes only when something is due (gateway-split.md §4.2, G5): a child's paced status read or
  // failure retry, a parent notification's delivery time, a pending native acknowledgement, or, for a target with
  // neither or work left over, one 500 ms period after the sweep began. With nothing to watch it does not wake. Every
  // operation that can add a target or work signals, so the next sweep is due at once.
  private wake:OwnerWake|null=null;
  private due:DueOwnerWork|null=null;
  /** Owner-clock time the next timer sweep is due, from the last sweep; null when it left nothing to watch. */
  private sweepDue:number|null=null;
  /** Owner-clock time a pending native acknowledgement is retried. */
  private ackDue:number|null=null;
  /** An operation changed targets or work after the running sweep read them. */
  private signalled=false;
  private sweep:Promise<void>|null=null;
  private closed=false;
  private reportedSweepFailure=false;
  private readonly observations=new Set<Promise<void>>();
  private readonly pacingEpoch=new Map<string,number>();
  private readonly statusReads=new Map<string,{epoch:number;promise:Promise<OrchestrationRuntimeSnapshot>}>();
  private readonly statusFailures=new Map<string,{attempts:number;dueAt:number}>();
  private readonly pacing=new Map<string,{key:string;unchanged:number;since:number;dueAt:number;state:OrchestrationRuntimeSnapshot}>();
  constructor(readonly collaboration:Collaboration,private readonly execution:OrchestrationExecutionPort,private readonly now=Date.now,private readonly runtimeStorage?:OrchestrationRuntimeStorage){}
  private assistant?: AssistantThreadAuthority;
  private detachAssistant?: () => void;
  enableAssistantThreads(access: ThreadAccessStore): void {
    if(this.assistant || this.closed)throw Error('Assistant Thread adapter already configured or closed');
    const authority=new AssistantThreadAuthority(this.collaboration,access);
    const detach=this.collaboration.attachAssistantThreads(this);
    this.assistant=authority;this.detachAssistant=detach;
  }
  async initializeAssistantThreads():Promise<void>{await this.assistant?.initialize();}
  command(c:ActorContext,method:string,p:Record<string,unknown>):Promise<unknown>{
    if(!this.assistant||this.closed)throw new CollaborationError(503,'assistant_threads_unavailable');
    return this.assistantCommand(c,method,p).finally(()=>this.signal());
  }
  allowsInput(grant:any,threadId:string):boolean{return !this.closed&&!!this.assistant?.allowsInput(grant,threadId);}
  refreshInput(grant:any,threadId:string):Promise<void>{
    if(!this.assistant||this.closed)throw new CollaborationError(503,'assistant_threads_unavailable');
    return this.assistant.refreshInput(grant,threadId);
  }
  invalidate(threadId?:string,ownerActorId?:string,botId?:string):void{this.assistant?.invalidate(threadId,ownerActorId,botId);}
  private get runtime(){if(!this.runtimeStorage)throw new CollaborationError(503,'orchestration_runtime_unavailable');return this.runtimeStorage;}
  /** Starts the timer sweep on `ownerWake` (the default Node timeout one; a single-alarm owner passes its merged alarm).
   * The first sweep is one period after start, as before, and finds the targets left by an earlier process. */
  start(ownerWake:OwnerWake=timeoutOwnerWake()):void {
    if(!this.runtimeStorage)throw new CollaborationError(503,'orchestration_runtime_unavailable');
    if(this.due||this.closed)return;
    this.wake=ownerWake;this.sweepDue=ownerWake.now()+ORCHESTRATION_POLL_MIN_MS;
    this.due=dueOwnerWork(ownerWake,()=>{
      // A running sweep re-arms when it settles; arming meanwhile would only wake into it.
      if(this.closed||this.sweep)return null;
      if(this.signalled)return ownerWake.now();
      const sweep=this.sweepDue,ack=this.ackDue;
      return sweep===null?ack:ack===null?sweep:Math.min(sweep,ack);
    },()=>{
      if(this.sweep)return;
      void this.reconcile(true).then(()=>{this.reportedSweepFailure=false;},()=>{if(!this.reportedSweepFailure){this.reportedSweepFailure=true;console.warn('[opencraft orchestration]',JSON.stringify({event:'orchestration-sweep-failed'}));}});
    });
  }
  /** Something may have added a target or work; the next sweep is due at once. */
  private signal():void{this.signalled=true;this.due?.reschedule();}
  get available():boolean{return !this.closed&&!!this.runtimeStorage;}
  stop():void{this.closed=true;void this.assistant?.close();this.detachAssistant?.();this.detachAssistant=undefined;this.due?.close();this.pacing.clear();this.pacingEpoch.clear();this.statusFailures.clear();this.statusReads.clear();}
  async close():Promise<void>{this.stop();await this.sweep?.catch(()=>{});await this.ackSweep?.catch(()=>{});await Promise.allSettled([...this.observations]);await Promise.allSettled([...this.calls.values()].map(call=>call.promise));await Promise.allSettled(this.operationCalls.values());}
  async invoke(threadId:string,turnId:string,toolCallKey:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    if(!this.available)return Promise.reject(new CollaborationError(503,this.closed?'orchestration_closed':'orchestration_runtime_unavailable'));
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
      let intent;
      try{intent=threadDeliveryIntent(mapped.delivery,mapped.expectedTurnId);}
      catch(error){throw new CollaborationError((error as Error).message==='unsupported_delivery'?409:400,(error as Error).message);}
      delete mapped.delivery;mapped.mode=intent.mode;
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
        title:automationThreadTitle(target.prompt),prompt:target.prompt,driver:target.driver,model:target.model,...(target.reasoning?{reasoningEffort:target.reasoning}:{}),idempotencyKey:run.key},delegation.id) as {operationId:string;threadId:string};
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
  /** Every tool operation may add a child, a wait or a notification; the sweep looks again once it settles. */
  private perform(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    return this.performTool(threadId,turnId,key,name,args,delegationId,callbackIncarnation).finally(()=>this.signal());
  }
  private async performTool(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>{
    // A direct operation on a child is new evidence; read it again on the next sweep.
    if(!['thread_wait','read_thread','get_thread_delivery'].includes(name))for(const id of [args.threadId,...(Array.isArray(args.threadIds)?args.threadIds:[])])if(typeof id==='string'){this.pacing.delete(id);this.statusFailures.delete(id);this.pacingEpoch.set(id,(this.pacingEpoch.get(id)??0)+1);}
    if(['read_thread','send_message_to_thread','get_thread_delivery'].includes(name))return this.conversationTool(threadId,turnId,key,name,args,delegationId);
    if(!ORCHESTRATION_TOOL_NAMES.includes(name as typeof ORCHESTRATION_TOOL_NAMES[number]))throw new CollaborationError(400,'unknown_orchestration_tool');
    const delegation=this.collaboration.delegation(threadId,turnId,delegationId),ledger=this.collaboration.orchestration;
    let target:string|null=null,mode='read',spawnTitle:string|null=null;
    if(name==='thread_spawn'){
      fields(args,['title','prompt','parentSelf','bindLifecycleToSelf','visibility','driver','model','reasoningEffort','cwd','idempotencyKey']);text(args.prompt,16384);
      spawnTitle=parseThreadTitle(args.title);
      for(const field of ['model','reasoningEffort','cwd'])if(args[field]!==undefined)text(args[field],field==='cwd'?4096:256);
      if(args.driver!==undefined&&!['codex','pi','dsh','acp','claude-code'].includes(String(args.driver)))throw new CollaborationError(400,'orchestration_driver_unsupported');
      if(args.parentSelf!==undefined&&args.parentSelf!==true||args.bindLifecycleToSelf!==undefined&&args.bindLifecycleToSelf!==true)throw new CollaborationError(400,'invalid_parent_binding');
      if(args.visibility!==undefined&&!['visible','hidden'].includes(String(args.visibility)))throw new CollaborationError(400,'invalid_thread_visibility');
      this.authorize(delegation,threadId,'execution.delegate');mode='start';
    }else if(name==='thread_set_title'){
      fields(args,['title','idempotencyKey']);
      const title=parseThreadTitle(args.title);if(title===null)throw new CollaborationError(400,'thread_title_required');
      if(!this.execution.setTitle||!this.runtimeStorage)throw new CollaborationError(409,'unsupported_capability');
      args={...args,title};target=threadId;mode='title';this.authorize(delegation,threadId,'conversation.read');
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
      targetThreadId:target,clientMessageId:null,mode,arguments:args,...(args.idempotencyKey===undefined?{}:{idempotencyKey:text(args.idempotencyKey,128)})},()=>{
      if(name==='thread_spawn'&&spawnTitle===null)throw new CollaborationError(400,'thread_title_required');
    });
    return this.withOperation(operation,async()=>{
    if(name==='thread_set_title'){
      const storage=this.runtimeStorage;
      if(!storage||!this.execution.setTitle)throw new CollaborationError(409,'unsupported_capability');
      const result={threadId,status:'unconfirmed' as 'updated'|'unconfirmed'};
      if(await storage.claimTitleWrite(operation.operationId)){
        if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');
        try{await this.execution.setTitle(operation.operationId,threadId,String(args.title),()=>this.valid(delegation,turnId));result.status='updated';}
        catch{/* Preserve uncertainty, including loss after the native save. */}
      }
      await storage.finishTitleWrite(key,result);return result;
    }
    if(name==='thread_spawn'){
      this.collaboration.reserveSpawn(operation.operationId,delegation);
      let settings=this.collaboration.spawnPreparation(operation.operationId);
      if(!settings){const input=spawnTitle===null?args:{...args,title:spawnTitle};const prepared=await this.execution.prepare?.(operation.operationId,threadId,input,()=>this.valid(delegation,turnId),callbackIncarnation)??input;if(!this.valid(delegation,turnId))throw new CollaborationError(403,'execution_delegation_revoked');settings=this.collaboration.prepareSpawn(operation.operationId,prepared);}
      const scope=await this.automations?.checkDelegation(delegation.id);
      if(scope){
        if(!scope.valid || scope.grant && permissionSnapshot(settings)!==scope.grant.permissionSnapshot)throw new CollaborationError(403,'automation_permissions_changed');
      }
      const created=await this.execution.create(operation.operationId,threadId,settings,()=>this.valid(delegation,turnId));
      const rejection='rejected' in created?created.rejected:null;
      const allocation='rejected' in created?created.rejected.allocation:created;
      if(!allocation){
        const status=rejection!.status;
        ledger.transaction(()=>{ledger.finish(key,{orchestrationFailure:{status}},'failed');this.collaboration.queueOrchestrationAck(operation.operationId);});
        void this.reconcileAcks();throw new CollaborationError(status,'native_child_creation_rejected');
      }
      const childId=text(allocation.threadId),parent=ledger.relation(threadId);
      await this.childScope?.(this.reference(threadId),this.reference(childId));
      ledger.transaction(()=>{
        const failedStatus=rejection?.status??(this.valid(delegation,turnId)?null:403);
        ledger.createThread({threadId:childId,serverId:this.reference(childId).serverId,driverKind:allocation.driverKind??String(settings.driver??args.driver??'codex'),ownerActorId:delegation.context.actorId,parentThreadId:threadId,
          lifecycleOwnerThreadId:threadId,forkedFromId:null,visibility:!rejection&&args.visibility==='visible'?'visible':'hidden',engineHostGeneration:allocation.generationId??null,nativeSessionId:childId,
          runtimeStatus:failedStatus===null?'starting':'error',rootTurnId:null,turnId:null,delegationRevision:delegation.context.generation,autoExchangeDepth:(parent?.autoExchangeDepth??0)+1,hasDirectUserInput:false,userInputExcerpt:null});
        if(failedStatus!==null){
          ledger.finish(key,{orchestrationFailure:{status:failedStatus}},'failed',childId);this.collaboration.queueOrchestrationAck(operation.operationId);return;
        }
        const sent=this.collaboration.sendConversation(delegation.context,{reference:this.reference(childId),content:args.prompt,
          idempotencyKey:`spawn:${operation.operationId}`,execution:{mode:'queue'}},this.reference(threadId),delegation.id,false,scope?.grant?key:undefined);
        const inputId=ACTOR_INPUT_PREFIX+sent.requestId;
        this.collaboration.authorizeChild(delegation,childId,inputId);
        if(!scope?.grant)this.collaboration.recordInputOrigin(childId,inputId,this.origin(delegation,operation,inputId,turnId));
        ledger.finish(key,{operationId:operation.operationId,threadId:childId,status:'starting',durability:allocation.durability??'pending_first_turn',delivery:'sent'},'completed',childId,inputId);
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
      let timer:ReturnType<typeof setTimeout>|undefined;
      const query=remaining===0?Promise.resolve(null):Promise.all(ticket.targetThreadIds.map(id=>this.readStatus(id))).catch(()=>null);
      let states:OrchestrationRuntimeSnapshot[]|null;
      try{states=remaining===0?null:await Promise.race([query,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),remaining);})]);}
      finally{if(timer)clearTimeout(timer);}
      checkWait();
      if(!states){void query.catch(()=>{});result={settled:false,waitTicketId:ticket.waitTicketId,threads:ticket.targetThreadIds.map(id=>({threadId:id,status:ledger.relation(id)?.runtimeStatus??'unknown'}))};break;}
      const settled=ticket.waitFor==='all_settled'?states.every(state=>terminal.has(state.state)):states.some(state=>terminal.has(state.state));
      if(settled)ledger.settleWait(ticket.waitTicketId,'satisfied');
      result={settled,waitTicketId:ticket.waitTicketId,threads:states};
      if(settled||Date.now()>=deadline||this.closed)break;
      await delay(Math.min(500,Math.max(0,deadline-Date.now())));
    }while(true);
    checkWait();ledger.finish(key,result);return result;
    });
  }
  private async assistantCommand(
    c: ActorContext,
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed)
      throw new CollaborationError(503, "assistant_threads_unavailable");
    if (method.endsWith("/threads/profiles")) {
      fields(p, ["botId"]);
      return this.assistant!.store(c, "human-profiles", p);
    }
    if (method.endsWith("/threads/sources")) {
      fields(p, ["botId","cursor"]);
      if (p.cursor !== undefined) text(p.cursor, 2048);
      await this.collaboration.communicate(
        c,
        "personal-assistant/model-authority",
        p.botId===undefined?{}:{botId:p.botId},
      );
      const result = await this.collaboration.discover(
        c,
        "",
        (p.cursor ?? null) as string | null,
      );
      return {
        ...result,
        conversations: result.conversations.filter(
          (v) =>
            this.collaboration.execution.hostForServer?.(v.ref.serverId) ===
              "local-codex" &&
            this.collaboration.conversationAllowed(c, v.ref, "execution.delegate"),
        ),
      };
    }
    if (method.endsWith("/profile/set")) {
      fields(p, ["botId","id", "reference", "expectedRevision"]);
      text(p.id, 80);
      const source = assistantRef(p.reference);
      const a = await this.collaboration.communicate(
        c,
        "personal-assistant/model-authority",
        p.botId===undefined?{}:{botId:p.botId},
      );
      const sourceAuthority = await this.assistant!.store(c, "source-authority", {
        reference: encodeConversationRef(source),
      });
      const valid = () => !this.closed && this.assistant!.sourceAllowed(sourceAuthority);
      if (!valid() || !this.execution.prepare || !this.execution.createRoot)
        throw new CollaborationError(
          403,
          "assistant_thread_profile_unavailable",
        );
      // First version uses the local Codex driver; unsupported routing is explicit.
      if (
        this.collaboration.execution.hostForServer?.(source.serverId) !==
        "local-codex"
      )
        throw new CollaborationError(409, "assistant_thread_host_unsupported");
      const prepared = await this.execution.prepare(
        "assistant-profile:" + randomUUID(),
        source.threadId,
        {},
        valid,
      );
      if (!valid())
        throw new CollaborationError(
          403,
          "assistant_thread_source_unavailable",
        );
      const {
        orchestrationSourceThreadId,
        orchestrationHostIncarnation,
        orchestrationCrossDriver,
        ...settings
      } = prepared;
      if (
        typeof settings.permissions === "string" &&
        !codexPermissionMode(settings.permissions)
      )
        throw new CollaborationError(
          409,
          "assistant_thread_permission_profile_unsupported",
        );
      this.assistant!.invalidate(undefined, c.actorId);
      return this.assistant!.store(c, "profile-save", {
        ...p,
        reference: encodeConversationRef(source),
        settings,
        epoch: a.epoch,
      });
    }
    if (method.endsWith("/profile/revoke")) {
      fields(p, ["botId","id", "expectedRevision"]);
      const a = await this.collaboration.communicate(
        c,
        "personal-assistant/model-authority",
        p.botId===undefined?{}:{botId:p.botId},
      );
      this.assistant!.invalidate(undefined, c.actorId);
      return this.assistant!.store(c, "profile-revoke", { ...p, epoch: a.epoch });
    }
    fields(p, ["argv", "workId"]);
    if (p.workId !== undefined) text(p.workId, 256);
    const cmd = parseThreadCommand(p.argv as string[]),
      args = cmd.arguments;
    if (cmd.command === "profiles") {
      const result = await this.assistant!.store(c, "profiles");
      const profiles = [];
      for (const v of result.profiles) {
        try {
          await this.assistant!.check(c, v.id, v.revision);
          profiles.push(v);
        } catch (error) {
          if (![403, 409].includes(Number((error as any).status))) throw error;
        }
      }
      return { profiles };
    }
    if (cmd.command === "list") {
      if (args.owned !== true)
        throw new CollaborationError(400, "use_list_owned");
      if (args.cursor !== undefined) text(args.cursor, 2048);
      const limit = Number(args.limit ?? 50);
      if (limit > 100) throw new CollaborationError(400, "invalid_limit");
      const rows = await this.assistant!.store(c, "list", {
          after: args.cursor ?? "",
          limit,
        }),
        page = rows.slice(0, limit);
      return {
        threads: page.map((r: any) => this.assistant!.receipt(r)),
        nextCursor: rows.length > limit ? page.at(-1).id : null,
      };
    }
    if (cmd.command === "operation") {
      const r = await this.assistant!.store(c, "operation", args);
      const reference = r.reference ?? JSON.parse(r.args).reference;
      if (reference) await this.assistant!.current(c, r, assistantRef(reference).threadId);
      const delivery = await this.assistant!.store(c, "delivery", { id: r.id, native: true });
      if (!delivery.found) return this.assistant!.receipt(r);
      const native = await this.collaboration.execution.receipt(delivery.nativeBinding, delivery.receipt.requestId, {includeCompletion:true});
      await this.assistant!.current(c, r, delivery.receipt.ref.threadId);
      const persistedTurn = delivery.receipt.targetTurnId;
      const targetTurnId = persistedTurn ?? native?.targetTurnId ?? null;
      const completion = (!persistedTurn || !native?.targetTurnId || persistedTurn === native.targetTurnId)
        ? parseInputCompletion(native?.completion, targetTurnId) : undefined;
      return {
        ...this.assistant!.receipt(r),
        input: {
          ...delivery.receipt,
          targetTurnId,
          completion: completion ?? {
            version: 1, turnId: targetTurnId, status: "unknown", text: "", truncated: false,
            // No native row is an observation gap, not proof of unsupported or
            // exhausted history. Keep tracking the same durable operation.
            ...(native == null ? {} : { unavailable: true }),
          },
        },
      };
    }
    if (cmd.command === "stop") {
      text(args.expectedTurnId,256);
      const r=await this.assistant!.store(c,"target",{reference:encodeConversationRef(assistantRef(args.reference))});
      const g=await this.assistant!.current(c,r),target=assistantRef(r.reference);
      if(g.takenOver||!this.collaboration.conversationAllowed(g.context,target,"execution.cancel"))throw new CollaborationError(403,"assistant_task_stop_denied");
      const state=await this.execution.snapshot(target.threadId);
      if(state.turnId!==args.expectedTurnId)throw new CollaborationError(409,"task_turn_changed");
      await this.assistant!.current(c,r);
      if(["completed","failed","exhausted","interrupted_by_user"].includes(state.state))return {stopped:false,state:state.state};
      if(!this.execution.interrupt)throw new CollaborationError(503,"task_stop_unavailable");
      await this.execution.interrupt(target.threadId,String(args.expectedTurnId),()=>this.assistant!.sourceAllowed(g)&&this.collaboration.actors.isCurrent(c)&&this.collaboration.conversationAllowed(g.context,target,"execution.cancel"));
      await this.assistant!.current(c,r);return {stopped:true,turnId:args.expectedTurnId};
    }
    if (cmd.command === "output" || cmd.command === "show") {
      if (args.includeRecentTurns !== undefined)
        throw new CollaborationError(400, "use_output_cursor");
      const r = await this.assistant!.store(c, "target", {
        reference: encodeConversationRef(assistantRef(args.reference)),
      });
      const g = await this.assistant!.current(c, r),
        target = assistantRef(r.reference);
      const history = await this.collaboration.readConversation(
        g.context,
        target,
        (args.cursor ?? null) as string | null,
        true,
      );
      const state = await this.execution.snapshot(target.threadId);
      await this.assistant!.current(c, r);
      return { ...history, state, reference: r.reference, workId: r.work_id };
    }
    if (!["start", "tell"].includes(cmd.command))
      throw new CollaborationError(400, "unsupported_assistant_thread_command");
    if (cmd.command === "start") {
      text(args.profile, 80);
      text(args.prompt, 16384);
      if (args.title !== undefined) text(args.title, 256);
    } else {
      args.reference = encodeConversationRef(assistantRef(args.reference));
      text(args.message, 16384);
      try {
        threadDeliveryIntent(args.delivery,args.expectedTurnId);
      } catch(error) {
        throw new CollaborationError((error as Error).message==='unsupported_delivery'?409:400,(error as Error).message);
      }
      // Normalize only the new alias: old persisted arguments/defaults keep their fingerprints.
      if(args.delivery==='native')args.delivery='steer';
      if (args.replyExpectation !== undefined)
        throw new CollaborationError(
          400,
          "assistant_thread_reply_expectation_unsupported",
        );
      if (args.delivery === "steer") text(args.expectedTurnId, 256);
      else if (args.expectedTurnId !== undefined)
        throw new CollaborationError(400, "unexpected_turn");
    }
    const r = await this.assistant!.store(c, "accept", {
      command: cmd.command,
      args,
      key: cmd.idempotencyKey,
      workId: p.workId,
    });
    if (["submitted", "rejected"].includes(r.state)) return this.assistant!.receipt(r);
    return this.coalesceOperation('assistant:'+r.id,()=>this.performAssistant(c,r));
  }
  private async performAssistant(c: ActorContext, r: any) {
    // Queue acceptance and command completion are separate commits. Recover the
    // durable queue receipt before attempting any new effect or takeover check.
    const delivery = await this.assistant!.store(c, "delivery", { id: r.id });
    if (delivery.found)
      return this.assistant!.receipt(
        await this.assistant!.store(c, "finish", {
          id: r.id,
          state: "submitted",
          reference: encodeConversationRef(delivery.receipt.ref),
          result: {
            requestId: delivery.receipt.requestId,
            delivery: "accepted",
            taskOutcome: "unknown",
            inputMode: delivery.receipt.mode,
            ...(delivery.receipt.mode === "steer"
              ? { expectedTurnId: JSON.parse(r.args).expectedTurnId }
              : {}),
          },
        }),
      );
    const args = JSON.parse(r.args);
    let g = await this.assistant!.current(c, r),
      target = r.reference ? assistantRef(r.reference) : null;
    if (r.command === "start" && !target) {
      if (!this.execution.createRoot)
        throw new CollaborationError(503, "assistant_threads_unavailable");
      const settings = {
        ...JSON.parse(g.profile.settings as string),
        ...(args.title ? { orchestrationTitle: args.title } : {}),
      };
      const created = await this.execution.createRoot(
        r.id,
        settings,
        () =>
          !this.closed &&
          g.expiresAt > this.collaboration.now() &&
          this.collaboration.actors.isCurrent(c) &&
          this.assistant!.sourceAllowed(g),
      );
      if ("rejected" in created)
        return this.assistant!.receipt(
          await this.assistant!.store(c, "finish", {
            id: r.id,
            state: "rejected",
            result: {
              reason: "native_creation_rejected",
              status: created.rejected.status,
            },
          }),
        );
      const serverId =
        this.collaboration.execution.serverForThread?.(created.threadId) ??
        this.collaboration.execution.serverId!;
      target = { serverId, threadId: created.threadId };
      // Ownership registration is independent of sending the first input. An orphan remains findable.
      const relation: import("./assistant-thread-store.js").AssistantThreadAllocation["relation"] =
        {
          threadId: created.threadId,
          serverId,
          driverKind: created.driverKind ?? "codex",
          ownerActorId: g.context.actorId,
          parentThreadId: null,
          lifecycleOwnerThreadId: null,
          forkedFromId: null,
          visibility: "visible",
          engineHostGeneration: created.generationId ?? null,
          nativeSessionId: created.threadId,
          runtimeStatus: "idle",
          rootTurnId: null,
          turnId: null,
          delegationRevision: g.context.generation,
          autoExchangeDepth: 0,
          hasDirectUserInput: false,
          userInputExcerpt: null,
        };
      r = await this.collaboration.recordAssistantThreadAllocation({
        id: r.id,
        actor: c,
        owner: g.context,
        reference: encodeConversationRef(target),
        relation,
      });
      this.assistant!.acceptCreated({
        serverId,
        threadId: created.threadId,
        creatorActorId: g.context.actorId,
        accessMode: "private",
        revision: 1,
      });
    }
    // Publication is independent of command authorization: even a revoked Bot
    // leaves its allocated Thread privately owned by the original Human.
    if(r.command === "start") await this.execution.publishRoot?.(r.id);
    target ??= assistantRef(args.reference);
    g = await this.assistant!.current(c, r);
    if (r.command === "start") {
      await this.execution.finalizeRoot?.(r.id,target.threadId,{
        ...JSON.parse(g.profile.settings as string),
        ...(args.title ? { orchestrationTitle: args.title } : {}),
      },()=>!this.closed && g.expiresAt>this.collaboration.now() && this.collaboration.actors.isCurrent(c) && this.assistant!.sourceAllowed(g));
      g = await this.assistant!.current(c,r);
    }
    if (r.command === "tell") {
      const observed = await this.execution.snapshot(target.threadId);
      g = await this.assistant!.current(c, r);
      if (observed.state === "interrupted_by_user")
        throw new CollaborationError(409, "assistant_thread_user_control");
      // Pin the actual running turn. A stale steer must never become a queued
      // follow-up or silently target a newer turn. The native queue rechecks it
      // again at injection, closing the snapshot-to-send race.
      if (args.delivery === "steer") {
        if (observed.turnId !== args.expectedTurnId)
          throw new CollaborationError(409, "assistant_thread_turn_changed");
        if (observed.state !== "active")
          throw new CollaborationError(409, "assistant_thread_not_running");
      }
    }
    const sent = await this.assistant!.store(c, "send", {
      id: r.id,
      profile: String(r.profile_id),
      revision: Number(r.profile_revision),
      epoch: String(r.epoch),
      reference: target,
      content: args.prompt ?? args.message,
    });
    await this.assistant!.refreshInput(
      {
        actor: c,
        profile: r.profile_id,
        revision: r.profile_revision,
        epoch: r.epoch,
      },
      target.threadId,
    );
    const result = {
      reference: encodeConversationRef(target),
      requestId: sent.requestId,
      delivery: "accepted",
      taskOutcome: "unknown",
      inputMode: args.delivery === "steer" ? "steer" : "queue",
      ...(args.delivery === "steer"
        ? { expectedTurnId: args.expectedTurnId }
        : {}),
    };
    const saved = await this.assistant!.store(c, "finish", {
      id: r.id,
      reference: result.reference,
      state: "submitted",
      result,
    });
    // Native receipt is retained until the durable operation records the result.
    if (r.command === "start")
      await this.execution.acknowledge?.(r.id).catch(() => {});
    void this.collaboration.pump().catch(() => {});
    return this.assistant!.receipt(saved);
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
    return this.coalesceOperation(operation.operationId,run);
  }
  /** One in-flight owner for all callers; durable receipts remain with their existing journals. */
  private coalesceOperation(id:string,run:()=>Promise<unknown>):Promise<unknown>{
    const prior=this.operationCalls.get(id);if(prior)return prior;
    const promise=run().finally(()=>{if(this.operationCalls.get(id)===promise)this.operationCalls.delete(id);});
    this.operationCalls.set(id,promise);return promise;
  }
  private reconcileAcks():Promise<void>{
    if(this.closed||!this.execution.acknowledge||!this.runtimeStorage)return Promise.resolve();
    return this.ackSweep??=(async()=>{
      // A failed or unconfirmed acknowledgement, or a full page, is retried one period later.
      let retry=false;
      try{
        const pending=await this.runtime.pendingAcks();retry=pending.length>=16;
        for(const id of pending){
          try{if(await this.execution.acknowledge!(id)!==false){await this.runtime.acknowledge(id);}else retry=true;}catch{retry=true;/* Durable intent remains for the next sweep. */}
        }
      }catch(error){retry=true;throw error;}
      finally{if(this.wake){this.ackDue=retry?this.wake.now()+ORCHESTRATION_POLL_MIN_MS:null;this.due?.reschedule();}}
    })().finally(()=>{this.ackSweep=null;});
  }
  observe(snapshot:OrchestrationRuntimeSnapshot,epoch=this.pacingEpoch.get(snapshot.threadId)??0):Promise<void>{
    if(this.closed)return Promise.resolve();
    const operation=this.runtime.observe(snapshot,this.now());this.observations.add(operation);
    void operation.then(()=>{this.observations.delete(operation);this.pace(snapshot.threadId,snapshot,this.now(),epoch);},()=>this.observations.delete(operation));
    return operation;
  }
  /** One status owner for waiters and timer sweeps; cache successes and pace failures. */
  private readStatus(id:string,fresh=false):Promise<OrchestrationRuntimeSnapshot>{
    const epoch=this.pacingEpoch.get(id)??0,inFlight=this.statusReads.get(id);if(inFlight?.epoch===epoch)return inFlight.promise;
    const now=this.now(),known=this.pacing.get(id),failed=this.statusFailures.get(id);
    if(!fresh&&failed&&failed.dueAt>now)return Promise.reject(new Error('Child status temporarily unavailable'));
    if(!fresh&&known&&known.dueAt>now)return Promise.resolve(known.state);
    let reading:Promise<OrchestrationRuntimeSnapshot>;try{reading=this.execution.snapshot(id);}catch(error){reading=Promise.reject(error);}
    const read=reading.then(async state=>{
      if((this.pacingEpoch.get(id)??0)!==epoch)throw new Error('Child status superseded');
      if(!this.closed)await this.observe(state,epoch);
      if((this.pacingEpoch.get(id)??0)===epoch)this.statusFailures.delete(id);return state;
    }).catch(error=>{
      if(this.closed||(this.pacingEpoch.get(id)??0)!==epoch)throw error;
      const attempts=(this.statusFailures.get(id)?.attempts??0)+1;
      const delayMs=Math.min(30_000,500*2**Math.min(attempts-1,6));
      this.statusFailures.set(id,{attempts,dueAt:this.now()+delayMs});
      if(attempts===1)console.warn('[opencraft orchestration]',JSON.stringify({event:'child-status-read-failed',retryMs:delayMs}));
      throw error;
    }).finally(()=>{if(this.statusReads.get(id)?.promise===read)this.statusReads.delete(id);});
    this.statusReads.set(id,{epoch,promise:read});return read;
  }
  reconcile(paced=false):Promise<void>{
    if(this.closed)return Promise.resolve();
    // A sweep that already read its targets may miss what the caller just changed; the next one is due at once.
    if(this.sweep){this.signalled=true;return this.sweep;}
    return this.sweep=this.runSweep(paced).finally(()=>{this.sweep=null;this.due?.reschedule();});
  }
  /** When target `id` is next due on the owner clock: its paced read or failure retry (wall clock, the clock they are
   * stamped and checked on), and never earlier than one period after the sweep began. */
  private targetDue(id:string,sweepStart:number):number{
    const pace=this.pacing.get(id)?.dueAt??-Infinity,failed=this.statusFailures.get(id)?.dueAt??-Infinity,wall=Math.max(pace,failed),floor=sweepStart+ORCHESTRATION_POLL_MIN_MS;
    return wall===-Infinity?floor:Math.max(floor,this.wake!.now()+(wall-this.now()));
  }
  /** Record one observed child state and schedule its next timer-driven read. */
  private pace(id:string,state:OrchestrationRuntimeSnapshot,now:number,epoch:number):void{
    if(this.closed||(this.pacingEpoch.get(id)??0)!==epoch)return;
    const key=JSON.stringify([state.state,state.turnId??null,state.rootTurnId??null]),prior=this.pacing.get(id),same=prior?.key===key;
    const unchanged=same?prior.unchanged+1:0,since=same?prior.since:now;
    const interval=state.state==='starting'&&now-since>=ORCHESTRATION_STALE_STARTING_MS?ORCHESTRATION_STALE_STARTING_POLL_MS
      :Math.min(ORCHESTRATION_POLL_MAX_MS,ORCHESTRATION_POLL_MIN_MS*2**Math.floor(unchanged/4));
    this.pacing.set(id,{key,unchanged,since,dueAt:now+interval,state});
  }
  private async runSweep(paced=false):Promise<void>{
    const sweepStart=this.wake?.now()??0,floor=sweepStart+ORCHESTRATION_POLL_MIN_MS;
    let due:number|null=null;
    const consider=(at:number)=>{if(due===null||at<due)due=at;};
    try{await this.sweepOnce(paced,sweepStart,consider);}
    catch(error){consider(floor);throw error;}
    finally{if(this.wake)this.sweepDue=due;}
  }
  private async sweepOnce(paced:boolean,sweepStart:number,consider:(at:number)=>void):Promise<void>{
    const floor=sweepStart+ORCHESTRATION_POLL_MIN_MS;
    void this.reconcileAcks().catch(()=>{});
    const ledger=this.collaboration.orchestration;
    // Changes from here on are not in this sweep; their signal makes the next one due at once.
    this.signalled=false;
    const targets=new Set(await this.runtime.targets(!this.reconciledStartup,this.now()));
    if(this.closed)return;
    const snapshots=new Map<string,OrchestrationRuntimeSnapshot>();
    for(const id of new Set([...this.pacing.keys(),...this.statusFailures.keys(),...this.pacingEpoch.keys()]))if(!targets.has(id)){this.pacing.delete(id);this.statusFailures.delete(id);this.pacingEpoch.delete(id);}
    const sweepAt=this.now();
    for(const id of targets){
      const pace=this.pacing.get(id);
      // Not due: the last observed state stands in (it already passed observe()).
      if(paced&&pace&&pace.dueAt>sweepAt){snapshots.set(id,pace.state);continue;}
      let state:OrchestrationRuntimeSnapshot;try{state=await this.readStatus(id,!paced);}catch{continue;}if(this.closed)return;snapshots.set(id,state);
    }
    this.reconciledStartup=true;
    if(this.wake)for(const id of targets)consider(this.targetDue(id,sweepStart));
    const work=await this.runtime.work(this.now());
    if(this.closed)return;
    // Notifications due now are delivered below, or retried one period later; one not yet due wakes at its time. A
    // runtime port that does not report it is looked at every period.
    if(work.notifications.length||work.nextNotificationAt===undefined)consider(floor);
    else if(work.nextNotificationAt!==null&&this.wake)consider(Math.max(floor,this.wake.now()+(work.nextNotificationAt-this.now())));
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
            // Its delivery time is read by the next sweep.
            consider(floor);
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

/** A spawned conversation needs a title; a scheduled run takes its prompt's first line. */
export function automationThreadTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/u).map(part => part.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/gu, ' ').replace(/\s+/gu, ' ').trim()).find(Boolean) ?? '';
  const title = Array.from(line).slice(0, 80).join('').trim();
  return title || 'Scheduled task';
}
