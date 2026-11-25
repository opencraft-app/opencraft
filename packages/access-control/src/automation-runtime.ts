import type { ActorContext } from '@opencraft/identity-core/actors';
import type { BoundedThreadDelegation } from './orchestration-authority.js';
import type { AutomationCaller, AutomationGrant } from './automation-ledger.js';
import type { AutomationInput, AutomationOperation, AutomationResult } from './orchestration-runtime-contract.js';
import { boundedWakeTimer, dueOwnerWork, periodicOwnerWork, timeoutOwnerWake, timeoutWakeClock, type DueOwnerWork, type OwnerWake, type PeriodicOwnerWork } from '@opencraft/owner-wake';
import { AutomationError, automationOccurrence, nextAutomationOccurrence, automationRecord, automationText, automationFields, parseAutomationTarget, type Automation, type AutomationRun } from './automation.js';

export interface AutomationStorage {
  automation<O extends AutomationOperation>(operation: O, input: AutomationInput<O>, now: number): Promise<AutomationResult<O>>;
}
export interface AutomationExecution {
  /** Validate project membership, effective permissions and current resource access. */
  validate(grant: AutomationGrant, context: ActorContext): Promise<string>;
  dispatch(automation: Automation, run: AutomationRun, grant: AutomationGrant, delegation?: BoundedThreadDelegation): Promise<{state:'running'|'completed'|'failed'|'unknown';result?:unknown}>;
  projection?(values:{authorityId:string;grantId:string;valid:boolean}[]):void;
  revoke?(grantId:string):void;
  inspect(run: AutomationRun): Promise<{state:'running'|'completed'|'failed'|'unknown';result?:unknown}>;
}
/** How often running and unknown runs are inspected (and run authorities projected) while there are any. */
export const AUTOMATION_RUN_CHECK_MS = 1000;
/** How far ahead a schedule's next occurrence is searched; with none in it, the schedule is looked at again then. */
export const AUTOMATION_SCHEDULE_HORIZON_MS = 3_600_000;
export interface ProjectAutomationWakes {
  /** Owner wake-up for the run check (a fixed period on its clock); the default Node timeout one. */
  ownerWake?: OwnerWake;
  /** Owner wake-up for schedule occurrences, which are wall-clock instants; the default re-reads the wall clock at
   * least every minute (`boundedWakeTimer`), so a clock set back does not launch early. A single-alarm owner passes its
   * merged alarm for both. */
  scheduleWake?: OwnerWake;
}
/**
 * The Server owns the timers. The serialized Worker owns all claims and receipts.
 *
 * Two owner wake-ups drive the same sweep (gateway-split.md §4.2, G5): schedules wake at their next occurrence (the
 * occurrence is computed by the same rules that launch it) and not at all while nothing is scheduled; running and
 * unknown runs have no change notification, so they are inspected every second, armed only while there are any.
 */
export class ProjectAutomations {
  private sweep?: Promise<void>;
  private followUp?: Promise<void>;
  private closing = false;
  private started?:Promise<void>;
  private readonly active = new Map<string,AutomationRun>();
  private readonly dispatches = new Set<Promise<unknown>>();
  private ownerWake?: OwnerWake;
  private runCheck: PeriodicOwnerWork | null = null;
  private schedule?: DueOwnerWork;
  /** When the next occurrence is due (wall time), as of the last sweep. */
  private scheduleDue: number | null = null;
  /** A definition changed after the last sweep read them; the next sweep is due now. */
  private sweepRequested = false;
  private unknownRuns = 0;
  private readonly occurrences = new Map<string,{at:number|null;until:number}>();
  constructor(private readonly storage: AutomationStorage, private readonly execution: AutomationExecution, private readonly now=Date.now) {}
  private call<O extends AutomationOperation>(operation: O, input: AutomationInput<O>): Promise<AutomationResult<O>> {return this.storage.automation(operation,input,this.now());}
  start(wakes: ProjectAutomationWakes = {}): Promise<void> {
    return this.started??=(async()=>{
      await this.call('recover',{});await this.refreshProjection();if(this.closing)return;
      this.ownerWake=wakes.ownerWake??timeoutOwnerWake();
      const scheduleWake=wakes.scheduleWake??{now:this.now,timer:(wake:()=>void)=>boundedWakeTimer(timeoutWakeClock(this.now),wake)};
      this.schedule=dueOwnerWork(scheduleWake,()=>{
        // A running sweep re-arms when it ends; arming meanwhile would only wake into it.
        if(this.closing||this.sweep)return null;
        const due=this.sweepRequested?this.now():this.scheduleDue;
        return due===null?null:scheduleWake.now()+Math.max(0,due-this.now());
      },()=>{void this.tick().catch(()=>{});});
      // The first sweep runs one period after start, as before; it learns the schedules and the runs to watch.
      this.armRunCheck(true);
    })();
  }
  /** Arms the run check while a run is in flight, running or unknown; disarms it otherwise. */
  private armRunCheck(force=false):void {
    if(!this.closing&&this.ownerWake&&(force||this.active.size||this.unknownRuns||this.dispatches.size))
      this.runCheck??=periodicOwnerWork(this.ownerWake,AUTOMATION_RUN_CHECK_MS,()=>{void this.tick().catch(()=>{});});
    else {this.runCheck?.close();this.runCheck=null;}
  }
  /** The next occurrence of any eligible schedule after `through`, searched at most one horizon ahead per schedule. */
  private nextOccurrence(values:readonly Automation[],through:number):number|null {
    const live=new Set<string>();let due:number|null=null;
    for(const value of values) {
      const key=value.id+':'+value.revision;live.add(key);
      let entry=this.occurrences.get(key);
      if(!entry||(entry.at===null?entry.until<=through:entry.at<=through)) {
        const until=through+AUTOMATION_SCHEDULE_HORIZON_MS;
        try {entry={at:nextAutomationOccurrence(value.schedule,through,until),until};}catch{continue;}
        this.occurrences.set(key,entry);
      }
      const at=entry.at??entry.until;
      if(due===null||at<due)due=at;
    }
    for(const key of this.occurrences.keys())if(!live.has(key))this.occurrences.delete(key);
    return due;
  }
  private async refreshProjection():Promise<void>{this.execution.projection?.(await this.call('projection',{}));}
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
    // Grant commands return the stored grant.
    const result=await this.call('grant',{caller,command,body,key}) as AutomationGrant;
    if(command==='revoke'){this.execution.revoke?.(result.id);await this.refreshProjection();}
    return result;
  }
  async checkDelegation(id:string):Promise<{derived:boolean;valid:boolean;grant?:AutomationGrant}> {
    return this.call('checkDelegation',{id});
  }
  async command(caller: AutomationCaller, command: string, input: unknown, key?: unknown): Promise<unknown> {
    if(this.closing)throw new AutomationError('automation_closed',503);
    const result=await this.call('command',{caller,command,body:automationRecord(input),key});
    // A changed definition may be due in the current minute; the next sweep reads them again now.
    this.sweepRequested=true;this.schedule?.reschedule();
    if(command==='run') {
      // `run` returns the definition and the occurrence it fixed.
      const run=result as {automation:Automation;occurrenceId:string};
      return this.launch(run.automation,run.occurrenceId);
    }
    return result;
  }
  private async launch(automation: Automation, occurrenceId: string): Promise<AutomationRun> {
    const claim=await this.call('claim',{id:automation.id,revision:automation.revision,occurrenceId});
    if(!claim.fresh)return claim.run;
    // A fresh claim always carries the definition and its current grant.
    const task=this.dispatch(claim.automation!,claim.run,claim.grant!);
    this.dispatches.add(task);this.armRunCheck();
    void task.finally(()=>{this.dispatches.delete(task);this.armRunCheck();}).catch(()=>{});
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
      const settled=await this.call('settle',{key:run.key,...outcome});
      if(settled.state==='running')this.active.set(run.key,settled);
    } catch(error) {
      // Any error after execution may have been attempted is ambiguous.
      await this.call('settle',{key:run.key,state:error instanceof AutomationError?'failed':'unknown',result:target.kind==='script'?{kind:'script',key:run.key,reason:'execution_outcome_unknown'}:{reason:error instanceof AutomationError?'admission_refused':'execution_outcome_unknown'}});
    }
  }
  /** Resolves after a sweep that started at or after this call. A running sweep
   * may already have read the clock and the ledger, so a request that arrives
   * while one runs is served by a single shared follow-up sweep, never by it. */
  tick(): Promise<void> {
    if(this.closing)return Promise.resolve();
    if(this.sweep)return this.followUp??=this.sweep.catch(()=>{}).then(()=>{this.followUp=undefined;return this.tick();});
    return this.sweep=(async()=>{
      await this.refreshProjection();
      for(const run of this.active.values()) {
        let outcome:Awaited<ReturnType<AutomationExecution['inspect']>>;
        try {outcome=await this.execution.inspect(run);}catch{outcome={state:'unknown'};}
        if(outcome.state!=='running') {
          await this.call('settle',{key:run.key,...outcome});this.active.delete(run.key);
        }
      }
      const unknown=await this.call('unknownRuns',{});this.unknownRuns=unknown.length;
      for(const run of unknown){
        try {const outcome=await this.execution.inspect(run);if(outcome.state==='completed'||outcome.state==='failed')await this.call('settle',{key:run.key,...outcome,proof:'native-inspection'});}catch{/* Keep the durable fence until native evidence is available. */}
      }
      this.sweepRequested=false;
      const now=this.now(),values=await this.call('eligible',{});
      for(const value of values) {
        if(this.closing)break;
        const occurrence=automationOccurrence(value.schedule,now);
        if(occurrence)await this.launch(value,occurrence);
      }
      // Occurrences up to `now` were looked at above; the next one is strictly later.
      this.scheduleDue=this.nextOccurrence(values,now);
    })().finally(()=>{this.sweep=undefined;this.armRunCheck();this.schedule?.reschedule();});
  }
  /** Authenticated owner asks for provider proof. This path never dispatches. */
  async reconcile(caller:AutomationCaller,id:string):Promise<unknown> {
    const value=await this.command(caller,'show',{id});
    const runs=await this.call('unknownRuns',{});
    const results=[];
    for(const run of runs.filter(run=>run.automationId===(value as Automation).id)) {
      const outcome=await this.execution.inspect(run);
      if(outcome.state==='completed'||outcome.state==='failed')results.push(await this.call('settle',{key:run.key,...outcome,proof:'native-inspection'}));
      else results.push(run);
    }
    return {items:results};
  }
  async close(): Promise<void> {
    this.closing=true;this.schedule?.close();this.armRunCheck();
    await this.sweep;await this.followUp;await Promise.allSettled([...this.dispatches]);
  }
}
