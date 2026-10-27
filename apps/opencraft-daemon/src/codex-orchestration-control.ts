import { createHash } from 'node:crypto';
import { isAbsolute,resolve,sep } from 'node:path';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { RecoveryTurn } from '@opencraft/host-recovery';
import type { AppServerThread } from '@opencraft/appserver-protocol';
import { permissionModeProfileId } from '@opencraft/appserver-protocol';

const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value:'';
export class OrchestrationControlError extends Error {constructor(readonly code:number,message:string){super(message);}}
export interface CodexOrchestrationControlPort {
  supported():boolean;
  incarnation?():string|null;
  routed?():boolean;
  request(method:string,params:Record<string,unknown>,admit?:()=>boolean):Promise<unknown>;
  read(threadId:string,limit:number):Promise<{thread:AppServerThread}>;
  recovery(threadId:string):Readonly<RecoveryTurn>|null;
  pendingInput(threadId:string):'pending'|'unknown'|false;
}
/** Trusted Hub lane; independent of logical clients and their per-thread locks. */
export class CodexOrchestrationControl {
  constructor(private readonly port:CodexOrchestrationControlPort){}
  async handle(method:string,params:Record<string,unknown>,context:TransportSubmissionContext):Promise<unknown>{
    const operationId=context.orchestrationOperationId;
    if(!operationId || operationId!==params.operationId)throw new OrchestrationControlError(403,'Trusted orchestration admission required');
    const admit=context.orchestrationCanAdmit??(()=>false);
    if(!admit())throw new OrchestrationControlError(403,'Orchestration delegation was revoked');
    const threadId=text(params.threadId);
    if(method==='opencraft/orchestration/status')return this.snapshot(threadId);
    if(method==='opencraft/orchestration/inspect')return {entries:await this.preview(threadId,Number(params.limit??1))};
    if(!this.port.supported()&&!this.port.routed?.())throw new OrchestrationControlError(503,'The independent Engine Host does not support callback replay');
    if(method==='opencraft/orchestration/prepare')return this.prepare(threadId,object(params.arguments),text(params.callbackIncarnation),params.sourceSettings===undefined?undefined:object(params.sourceSettings));
    if(method==='opencraft/orchestration/ack'){
      let acknowledged=true;for(const id of [operationId,operationId+':title']){const reply=object(await this.port.request(method,{operationId:id,creationOperationId:operationId}));acknowledged=acknowledged&&reply.acknowledged===true;}
      return {acknowledged};
    }
    if(method!=='opencraft/orchestration/create')throw new OrchestrationControlError(400,'Unknown orchestration operation');
    const settings=object(params.settings),{orchestrationTitle,orchestrationHostIncarnation,orchestrationSourceThreadId,orchestrationCrossDriver,orchestrationDriver:_driver,driver:_kind,...start}=settings;
    const fingerprint=createHash('sha256').update(JSON.stringify(settings)).digest('hex');
    let result:Record<string,unknown>;
    try{result=object(await this.port.request('thread/start',{...start,__opencraftOrchestrationOperation:operationId,...(orchestrationCrossDriver?{}:{__opencraftOrchestrationSourceThreadId:orchestrationSourceThreadId??threadId}),__opencraftOrchestrationFingerprint:fingerprint,...(orchestrationHostIncarnation?{__opencraftOrchestrationIncarnation:orchestrationHostIncarnation}:{})},admit));}
    catch(error){if(object(object(error).data).orchestrationRejected===true)return {rejected:{status:Number(object(error).code)||503}};throw error;}
    const thread=object(result.thread),childId=text(thread.id);
    if(!childId)throw new OrchestrationControlError(502,'Native child creation has no stable identity');
    if(orchestrationTitle)try{await this.port.request('thread/name/set',{threadId:childId,name:orchestrationTitle,__opencraftOrchestrationOperation:operationId+':title',__opencraftOrchestrationFingerprint:fingerprint,...(orchestrationHostIncarnation?{__opencraftOrchestrationIncarnation:orchestrationHostIncarnation}:{})},admit);}catch(error){if(object(object(error).data).orchestrationRejected!==true)throw error;}
    return {threadId:childId,durability:'pending_first_turn'};
  }
  private async prepare(threadId:string,args:Record<string,unknown>,callbackIncarnation:string,sourceSettings?:Record<string,unknown>):Promise<Record<string,unknown>>{
    // The source is already executing this tool. Resume without overrides reads
    // its effective settings and subscribes; it never starts or interrupts a Turn.
    const live=sourceSettings??object(await this.port.request('thread/resume',{threadId,excludeTurns:true}));
    const cwd=text(live.cwd);
    if(!isAbsolute(cwd))throw new OrchestrationControlError(503,'Source workspace is unavailable');
    const requested=args.cwd===undefined?cwd:resolve(cwd,text(args.cwd));
    if(requested!==cwd&&!requested.startsWith(cwd.endsWith(sep)?cwd:cwd+sep))throw new OrchestrationControlError(403,'Child workspace exceeds the source delegation');
    const start:Record<string,unknown>={cwd:requested,...(sourceSettings?{orchestrationCrossDriver:true}:{orchestrationSourceThreadId:threadId})};
    const incarnation=callbackIncarnation||this.port.incarnation?.();if(incarnation)start.orchestrationHostIncarnation=incarnation;
    for(const key of ['approvalPolicy','approvalsReviewer','runtimeWorkspaceRoots',...(sourceSettings?[]:['modelProvider','serviceTier'])])if(live[key]!==undefined)start[key]=live[key];
    if(sourceSettings){
      const defaults=object(object(await this.port.request('config/read',{includeLayers:false})).config);
      const model=args.model??defaults.model;
      if(typeof model==='string'&&model.trim())start.model=model;
      if(typeof defaults.model_provider==='string'&&defaults.model_provider.trim())start.modelProvider=defaults.model_provider;
      if(args.reasoningEffort===undefined&&typeof defaults.model_reasoning_effort==='string'&&defaults.model_reasoning_effort.trim())start.config={model_reasoning_effort:defaults.model_reasoning_effort};
    }else if(args.model!==undefined||live.model!==undefined)start.model=args.model??live.model;
    const profile=text(object(live.activePermissionProfile).id)||text(live.permissions),sandbox=object(live.sandbox);
    if(sourceSettings&&profile){
      if(profile!==permissionModeProfileId('full'))throw new OrchestrationControlError(403,'Cannot translate the source permission profile');
      start.sandbox='danger-full-access';
    }
    else if(profile)start.permissions=profile;
    else if(sourceSettings&&live.sandbox==='danger-full-access')start.sandbox='danger-full-access';
    else{
      const modes:Record<string,string>={dangerFullAccess:'danger-full-access',readOnly:'read-only',workspaceWrite:'workspace-write'};
      if(!modes[text(sandbox.type)])throw new OrchestrationControlError(503,'Cannot preserve the source permission profile');
      start.sandbox=modes[text(sandbox.type)];
      if(sandbox.type==='workspaceWrite')start.config={sandbox_workspace_write:{writable_roots:sandbox.writableRoots,network_access:sandbox.networkAccess,exclude_tmpdir_env_var:sandbox.excludeTmpdirEnvVar,exclude_slash_tmp:sandbox.excludeSlashTmp}};
    }
    if(args.reasoningEffort!==undefined||!sourceSettings&&live.reasoningEffort)start.config={...object(start.config),model_reasoning_effort:args.reasoningEffort??live.reasoningEffort};
    if(args.title!==undefined)start.orchestrationTitle=args.title;
    return start;
  }
  private async preview(threadId:string,limit:number){
    if(!Number.isInteger(limit)||limit<1||limit>5)throw new OrchestrationControlError(400,'Invalid recent Turn limit');
    const {thread}=await this.port.read(threadId,limit),entries:Array<{turnId:string;role:'user'|'assistant';text:string}>=[];
    let bytes=0;
    for(const turn of [...thread.turns].reverse())for(const raw of [...(turn.items??[])].reverse()){
      const item=object(raw);if(item.type!=='userMessage'&&item.type!=='agentMessage')continue;
      const body=item.type==='agentMessage'?text(item.text):(Array.isArray(item.content)?item.content:[]).map(object).filter(part=>part.type==='text').map(part=>text(part.text)).join('\n');
      if(!body)continue;
      const entry={turnId:turn.id,role:item.type==='userMessage'?'user' as const:'assistant' as const,text:body};
      const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>23_000){
        // Keep a UTF-8-safe bounded tail when one human/assistant message is large.
        const chars=Math.max(0,Math.floor((23_000-bytes-256)/4)),tail=chars>0?Array.from(body).slice(-chars).join(''):'';
        if(tail)entries.unshift({...entry,text:tail});return entries;
      }
      bytes+=size;entries.unshift(entry);
    }
    return entries;
  }
  private async snapshot(threadId:string):Promise<unknown>{
    const recovery=this.port.recovery(threadId),base={threadId,turnId:recovery?.turnId??null,rootTurnId:recovery?.rootTurnId??null};
    if(recovery&&['interrupted','preparing','dispatching'].includes(recovery.state))return {...base,state:'recovering'};
    if(recovery?.state==='exhausted'||recovery?.state==='unconfirmed')return {...base,state:recovery.state};
    const {thread}=await this.port.read(threadId,1),turn=thread.turns.at(-1),status=object(thread.status);
    const input=this.port.pendingInput(threadId);
    if(input==='unknown')return {...base,state:'unconfirmed'};
    if(input==='pending')return {...base,state:'starting'};
    if(recovery?.state==='running'||status.type==='active')return {...base,state:'active'};
    const current={threadId,turnId:turn?.id??base.turnId,rootTurnId:recovery?.rootTurnId??turn?.id??null};
    if(status.type==='systemError')return {...current,state:'unconfirmed'};
    if(turn?.status==='inProgress')return {...current,state:'active'};
    if(!turn&&!recovery)return {...current,state:'starting'};
    const summary=(await this.preview(threadId,1)).filter(entry=>entry.role==='assistant').at(-1)?.text.slice(-4096);
    return {...current,state:turn?.status==='failed'?'failed':turn?.status==='interrupted'?(recovery?.state==='handled'&&recovery.handledReason==='user_stop'&&turn.id===recovery.turnId?'interrupted_by_user':'unconfirmed'):'completed',...(summary?{summary}:{})};
  }
}
