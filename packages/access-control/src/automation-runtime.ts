import type { ActorContext } from '@opencraft/identity-core/actors';
import type { BoundedThreadDelegation } from './orchestration-authority.js';
import type { AutomationCaller, AutomationGrant } from './automation-ledger.js';
import { AutomationError, automationOccurrence, automationRecord, automationText, automationFields, parseAutomationTarget, type Automation, type AutomationRun } from './automation.js';

export interface AutomationStorage {
  automation<T = any>(operation: string, input: unknown, now: number): Promise<T>;
}
export interface AutomationExecution {
  /** Validate project membership, effective permissions and current resource access. */
  validate(grant: AutomationGrant, context: ActorContext): Promise<string>;
  dispatch(automation: Automation, run: AutomationRun, grant: AutomationGrant, delegation?: BoundedThreadDelegation): Promise<{state:'running'|'completed'|'failed'|'unknown';result?:unknown}>;
  projection?(values:{authorityId:string;grantId:string;valid:boolean}[]):void;
  revoke?(grantId:string):void;
  inspect(run: AutomationRun): Promise<{state:'running'|'completed'|'failed'|'unknown';result?:unknown}>;
}
/** The Server owns the timer. The serialized Worker owns all claims and receipts. */
export class ProjectAutomations {
  private timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private closing = false;
  private started?:Promise<void>;
  private readonly active = new Map<string,AutomationRun>();
  private readonly dispatches = new Set<Promise<unknown>>();
  constructor(private readonly storage: AutomationStorage, private readonly execution: AutomationExecution, private readonly now=Date.now) {}
  private call<T = any>(operation: string, input: unknown = {}): Promise<T> {return this.storage.automation<T>(operation,input,this.now());}
  start(): Promise<void> {
    return this.started??=(async()=>{await this.call('recover');await this.refreshProjection();if(this.closing)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{});},1000);this.timer.unref();})();
  }
  private async refreshProjection():Promise<void>{this.execution.projection?.(await this.call('projection'));}
  async grant(caller: AutomationCaller, command: string, input: unknown, key: unknown): Promise<unknown> {
    const body=automationRecord(input);
    const previous=await this.call('grantReplay',{caller,command,body,key});if(previous)return previous;
    if(command==='create') {
      // Validation consumes a synthetic grant shape only after the human HTTP
      // caller was authenticated. SQL validates that human again at commit.
      automationFields(body,['serverId','projectId','target','permissionProfile']);
      const grant={...body,target:parseAutomationTarget(body.target),id:'pending',actorId:caller.context.actorId,generation:caller.context.generation,revokedAt:null,createdAt:this.now()} as unknown as AutomationGrant;
      const permissionSnapshot=await this.execution.validate(grant,caller.context);
      return this.call('grant',{caller,command,body:{...body,permissionSnapshot},key});
    }
    const result=await this.call<AutomationGrant>('grant',{caller,command,body,key});
    if(command==='revoke'){this.execution.revoke?.(result.id);await this.refreshProjection();}
    return result;
  }
  async checkDelegation(id:string):Promise<{derived:boolean;valid:boolean;grant?:AutomationGrant}> {
    return this.call('checkDelegation',{id});
  }
  async command(caller: AutomationCaller, command: string, input: unknown, key?: unknown): Promise<unknown> {
    if(this.closing)throw new AutomationError('automation_closed',503);
    const result=await this.call('command',{caller,command,body:automationRecord(input),key});
    if(command==='run') {
      return this.launch(result.automation,result.occurrenceId);
    }
    return result;
  }
  private async launch(automation: Automation, occurrenceId: string): Promise<AutomationRun> {
    const claim=await this.call('claim',{id:automation.id,revision:automation.revision,occurrenceId});
    if(!claim.fresh)return claim.run;
    const task=this.dispatch(claim.automation,claim.run,claim.grant);
    this.dispatches.add(task);void task.finally(()=>this.dispatches.delete(task)).catch(()=>{});
    return claim.run;
  }
  private async dispatch(automation: Automation, run: AutomationRun, grant: AutomationGrant): Promise<void> {
    const context:ActorContext={actorId:grant.actorId,generation:grant.generation,credentialId:null,expiresAt:this.now()+3_600_000};
    try {
      await this.execution.validate(grant,context);
      if(this.closing)throw new AutomationError('automation_closed',503);
    } catch {
      await this.call('settle',{key:run.key,state:'failed',result:{reason:'authorization_refused'}});return;
    }
    const target=automation.target;
    const sourceThreadId=target.kind==='once'?target.sourceThreadId:target.kind==='cron'?target.threadId:null;
    let delegation:BoundedThreadDelegation|undefined;
    try {
      delegation=sourceThreadId?await this.call('delegation',{key:run.key,sourceThreadId}):undefined;
      await this.refreshProjection();
      if(!await this.call('checkRunGrant',{key:run.key}))throw new AutomationError('automation_grant_revoked',403);
    }catch{await this.call('settle',{key:run.key,state:'failed',result:{reason:'preparation_refused'}});return;}
    try {
      const outcome=await this.execution.dispatch(automation,run,grant,delegation);
      const settled=await this.call<AutomationRun>('settle',{key:run.key,...outcome});
      if(settled.state==='running')this.active.set(run.key,settled);
    } catch(error) {
      // Any error after execution may have been attempted is ambiguous.
      await this.call('settle',{key:run.key,state:error instanceof AutomationError?'failed':'unknown',result:target.kind==='script'?{kind:'script',key:run.key,reason:'execution_outcome_unknown'}:{reason:error instanceof AutomationError?'admission_refused':'execution_outcome_unknown'}});
    }
  }
  tick(): Promise<void> {
    if(this.closing)return Promise.resolve();
    return this.sweep??=(async()=>{
      await this.refreshProjection();
      for(const run of this.active.values()) {
        let outcome:Awaited<ReturnType<AutomationExecution['inspect']>>;
        try {outcome=await this.execution.inspect(run);}catch{outcome={state:'unknown'};}
        if(outcome.state!=='running') {
          await this.call('settle',{key:run.key,...outcome});this.active.delete(run.key);
        }
      }
      for(const run of await this.call<AutomationRun[]>('unknownRuns')){
        try {const outcome=await this.execution.inspect(run);if(outcome.state==='completed'||outcome.state==='failed')await this.call('settle',{key:run.key,...outcome,proof:'native-inspection'});}catch{/* Keep the durable fence until native evidence is available. */}
      }
      const now=this.now(),values=await this.call<Automation[]>('eligible');
      for(const value of values) {
        if(this.closing)break;
        const occurrence=automationOccurrence(value.schedule,now);
        if(occurrence)await this.launch(value,occurrence);
      }
    })().finally(()=>{this.sweep=undefined;});
  }
  /** Authenticated owner asks for provider proof. This path never dispatches. */
  async reconcile(caller:AutomationCaller,id:string):Promise<unknown> {
    const value=await this.command(caller,'show',{id});
    const runs=await this.call<AutomationRun[]>('unknownRuns');
    const results=[];
    for(const run of runs.filter(run=>run.automationId===(value as Automation).id)) {
      const outcome=await this.execution.inspect(run);
      if(outcome.state==='completed'||outcome.state==='failed')results.push(await this.call('settle',{key:run.key,...outcome,proof:'native-inspection'}));
      else results.push(run);
    }
    return {items:results};
  }
  async close(): Promise<void> {
    this.closing=true;if(this.timer)clearInterval(this.timer);
    await this.sweep;await Promise.allSettled([...this.dispatches]);
  }
}
