import { ConversationRecoveryOwner, type RecoveryDemand, type RecoveryTask } from "../../../packages/workbench-runtime/src/recovery-policy";
import { ChaosViolation, recoveryChaosRandom, requireThat } from "./recovery-chaos";

type Resource = 0 | 1;
type Point = "resources" | "queued" | "history" | "history-started" | "history-authoritative" | "history-failed" | "failed" | "backoff" | "history-backoff" | "invalidated";
type Reaction = "remove" | "dispose" | "invalidate" | "replace" | "retry" | "join";
export type HistoryChaosEvent =
  | {type:"recover" | "retry" | "remove"; resource:Resource}
  | {type:"demand";resource:Resource;value:RecoveryDemand}
  | {type:"reply";resource:Resource;outcome:"success" | "retry" | "terminal";oldest?:boolean}
  | {type:"observe";resource:Resource;at:Point;action:Reaction}
  | {type:"tick";ms:number}
  | {type:"invalidate" | "dispose" | "heal"};
type Owner = Pick<ConversationRecoveryOwner,"getProgress" | "recover" | "remove" | "invalidate" | "dispose">;
export interface HistoryChaosOptions {
  createOwner?: (input:ConstructorParameters<typeof ConversationRecoveryOwner>[0])=>Owner;
  mutant?:"lost-admission";
}
interface Caller {resource:Resource;settled:boolean;retired:boolean;generation:number}
interface Read {resource:Resource;caller:Caller;generation:number;done:boolean;retryRequested?:boolean;resolve():void;reject(error:unknown):void}
class HistoryWorld {
  readonly keys=[{},{}];
  readonly demands:RecoveryDemand[]=["visible","open"];
  readonly callers:Caller[]=[];
  readonly reads:Read[]=[];
  readonly coverage:Record<string,number>={};
  readonly timers=new Map<number,{at:number;run():void}>();
  readonly owner:Owner;
  now=0;sequence=0;generation=0;disposed=false;healthy=false;disposedAtReads=0;invalidating=0;
  reaction:Extract<HistoryChaosEvent,{type:"observe"}>|undefined;
  immediateRetries:Array<{resource:Resource;generation:number;after:number}>=[];
  constructor(options:HistoryChaosOptions) {
    this.owner=(options.createOwner??(input=>new ConversationRecoveryOwner(input)))({hostId:"history-chaos",
      clock:{now:()=>this.now,setTimeout:(run,ms)=>{const id=++this.sequence;this.timers.set(id,{at:this.now+ms,run});return id;},
        clearTimeout:id=>{this.timers.delete(id as number);}},
      delaysMs:[1,2,4,8],
      changed:()=>{
        const reaction=this.reaction;if(!reaction)return;
        const stage=this.owner.getProgress(this.keys[reaction.resource])?.stage;
        if(stage===reaction.at || (reaction.at==="invalidated" && this.invalidating>0 && stage===undefined))this.react(reaction);
      },
      log:event=>{
        this.count(`stage-${event.stage}`);
        const reaction=this.reaction;
        if(reaction && event.stage===reaction.at)this.react(reaction);
      },
    });
    if(options.mutant) {
      const recover=this.owner.recover.bind(this.owner);
      this.owner.recover=(task,immediate)=>{void recover(task,immediate).catch(()=>undefined);return new Promise<void>(()=>undefined);};
    }
  }
  count(key:string) {this.coverage[key]=(this.coverage[key]??0)+1;}
  private retire(resource?:Resource) {
    for(const caller of this.callers)if(!caller.settled && (resource===undefined || caller.resource===resource))caller.retired=true;
  }
  private invalidate() {
    this.retire();this.immediateRetries=[];this.generation++;this.invalidating++;
    try{this.owner.invalidate();}finally{this.invalidating--;}
  }
  private dispose() {this.retire();this.immediateRetries=[];if(!this.disposed)this.disposedAtReads=this.reads.length;this.disposed=true;this.owner.dispose();}
  private remove(resource:Resource) {this.retire(resource);this.immediateRetries=this.immediateRetries.filter(retry=>retry.resource!==resource);this.owner.remove(this.keys[resource]!);}
  private react(reaction:NonNullable<HistoryWorld["reaction"]>) {
    // One-shot before any reentry, including invalidation's own notification.
    this.reaction=undefined;this.count(`observer-${reaction.at}-${reaction.action}`);
    if(reaction.action==="retry" && ["history-failed","failed","backoff","history-backoff"].includes(reaction.at)
      && this.demands[reaction.resource]==="visible" && !this.disposed
      && !this.reads.some(read=>read.resource===reaction.resource && !read.done && !read.caller.retired && read.generation===this.generation))
      this.immediateRetries.push({resource:reaction.resource,generation:this.generation,after:this.reads.length});
    if(reaction.action==="remove")this.remove(reaction.resource);
    if(reaction.action==="dispose")this.dispose();
    if(reaction.action==="invalidate" || reaction.action==="replace")this.invalidate();
    if(reaction.action==="replace" || reaction.action==="retry" || reaction.action==="join")this.recover(reaction.resource,reaction.action==="retry");
  }
  recover(resource:Resource,immediate=false) {
    if(immediate && !this.disposed && this.demands[resource]!=="cache") {
      const read=[...this.reads].reverse().find(read=>read.resource===resource && !read.done && !read.caller.retired && read.generation===this.generation);
      if(read){read.retryRequested=true;this.count("shared-read-retry-requested");}
    }
    const caller:Caller={resource,settled:false,retired:false,generation:this.generation};this.callers.push(caller);
    const task:RecoveryTask={key:this.keys[resource]!,demand:()=>this.demands[resource]!,retryable:error=>(error as {retryable?:boolean})?.retryable===true,
      run:()=>new Promise<void>((resolve,reject)=>{
        this.count("read-started");this.reads.push({resource,caller,generation:this.generation,done:false,resolve,reject});
      }),
    };
    try {
      void this.owner.recover(task,immediate).then(()=>{caller.settled=true;},()=>{caller.settled=true;});
    }catch(error){throw new ChaosViolation("HISTORY_OBSERVER",error instanceof Error?error.message:String(error));}
  }
  reply(resource:Resource,outcome:"success"|"retry"|"terminal",oldest=false) {
    const reads=this.reads.filter(read=>read.resource===resource && !read.done);
    const read=oldest?reads[0]:reads.at(-1);if(!read)return;
    if(read.caller.retired || read.generation!==this.generation) {
      this.count("retired-read-reply");
      if(this.reads.some(current=>current!==read && current.resource===resource && !current.done && !current.caller.retired && current.generation===this.generation))
        this.count("late-read-with-live-successor");
    }
    if(outcome!=="success" && read.retryRequested && !read.caller.retired && read.generation===this.generation && this.demands[resource]==="visible" && !this.disposed) {
      this.immediateRetries.push({resource,generation:this.generation,after:this.reads.length});
      this.count("shared-read-retry-after-failure");
    }
    this.count(`read-${outcome}`);read.done=true;
    if(outcome==="success")read.resolve();else read.reject({retryable:outcome==="retry"});
  }
  check() {
    for(const expected of this.immediateRetries) {
      requireThat(this.reads.slice(expected.after).some(read=>read.resource===expected.resource && read.generation===expected.generation),
        "HISTORY_IMMEDIATE_RETRY","explicit retry inherited the observer's old delay");
    }
    this.immediateRetries=[];
    if(this.disposed)requireThat(this.reads.length===this.disposedAtReads,"HISTORY_TERMINAL","disposed owner started another read");
    requireThat(this.timers.size<=2,"HISTORY_TIMER_BOUND",`${this.timers.size} active timers`);
    for(const caller of this.callers)if(caller.retired)
      requireThat(caller.settled,"HISTORY_SETTLEMENT","retired recovery caller remained pending");
    const active=this.reads.filter(read=>!read.done && !read.caller.retired && read.generation===this.generation);
    requireThat(active.length<=2,"HISTORY_CONCURRENCY",`${active.length} current reads`);
    for(const resource of [0,1] as const)
      requireThat(active.filter(read=>read.resource===resource).length<=1,"HISTORY_SINGLE_READ",`resource ${resource} read twice`);
  }
  async settle() {
    for(let i=0;i<4;i++) {
      if(this.healthy)for(const read of this.reads)if(!read.done){read.done=true;read.resolve();this.count("healthy-read-completed");}
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    this.check();
  }
  async apply(event:HistoryChaosEvent) {
    this.count(event.type);
    if(event.type==="observe")this.reaction=event;
    if(event.type==="recover" || event.type==="retry")this.recover(event.resource,event.type==="retry");
    if(event.type==="demand")this.demands[event.resource]=event.value;
    if(event.type==="remove")this.remove(event.resource);
    if(event.type==="invalidate")this.invalidate();
    if(event.type==="dispose")this.dispose();
    if(event.type==="reply")this.reply(event.resource,event.outcome,event.oldest);
    if(event.type==="tick") {
      this.now+=event.ms;
      for(const [id,timer] of [...this.timers])if(timer.at<=this.now){this.timers.delete(id);timer.run();}
    }
    if(event.type==="heal") {
      // Quiescence excludes further observers. Pending reads succeed; ordinary
      // retry timers remain real and must actually re-admit their work.
      this.reaction=undefined;this.healthy=true;
      for(let i=0;i<12;i++){await this.apply({type:"tick",ms:10});await this.settle();}
      requireThat(this.callers.every(caller=>caller.settled),"HISTORY_EVENTUAL","a recovery caller never settled after faults stopped");
      this.healthy=false;
    }
    await this.settle();
  }
  async close() {
    this.reaction=undefined;this.dispose();
    for(const read of this.reads)if(!read.done){read.done=true;read.resolve();}
    await this.settle();
    requireThat(this.timers.size===0,"HISTORY_CLEANUP","retry timers leaked");
  }
}
export async function simulateHistoryRecovery(events:readonly HistoryChaosEvent[],options:HistoryChaosOptions={}) {
  const world=new HistoryWorld(options);
  let failure:unknown;
  try {
    for(const event of events)await world.apply(event);
    await world.apply({type:"heal"});
    return {events:events.length,historyRuns:world.reads.length,historyCompleted:world.coverage["stage-history-authoritative"]??0,coverage:world.coverage};
  }catch(error){failure=error;throw error;}
  finally{
    try{await world.close();}catch(error){
      if(failure===undefined)throw error;
      if(failure instanceof ChaosViolation)failure.cleanupFailure=error instanceof Error?error.message:String(error);
    }
  }
}
export function generateHistoryChaos(seed:number,steps=120):HistoryChaosEvent[] {
  const rng=recoveryChaosRandom(seed),pick=<T>(values:readonly T[]):T=>values[Math.floor(rng()*values.length)]!;
  const events:HistoryChaosEvent[]=[];
  for(let i=0;i<steps;i++) {
    const resource=pick([0,1] as const),type=pick(["recover","recover","retry","remove","demand","reply","reply","observe","observe","invalidate","dispose","tick"] as const);
    if(i%32===31)events.push({type:"heal"});
    if(type==="observe") {
      let action=pick(["remove","dispose","invalidate","replace","retry","join"] as const);
      if(action==="dispose" && i<steps*.8)action="replace";
      events.push({type,resource,at:pick(["resources","queued","history","history-started","history-authoritative","history-failed","failed","backoff","history-backoff","invalidated"] as const),action});
    }else if(type==="demand")events.push({type,resource,value:pick(["visible","open","cache"] as const)});
    else if(type==="reply")events.push({type,resource,outcome:pick(["success","retry","terminal"] as const),oldest:rng()<.5});
    else if(type==="tick")events.push({type,ms:pick([0,1,2,8,50])});
    else if(type==="invalidate")events.push({type});
    else if(type==="dispose")events.push({type:i<steps*.8?"invalidate":"dispose"});
    else events.push({type,resource});
  }
  return events;
}
export function parseHistoryTrace(value:unknown):HistoryChaosEvent[] {
  requireThat(Array.isArray(value) && value.length<=10_000,"TRACE_SCHEMA","expected at most 10000 history events");
  for(const item of value) {
    requireThat(typeof item==="object" && item!==null,"TRACE_SCHEMA","invalid history event");
    const e=item as Record<string,unknown>;
    requireThat(["recover","retry","remove","demand","reply","observe","tick","invalidate","dispose","heal"].includes(String(e.type)),"TRACE_SCHEMA","unknown history event");
    if(["recover","retry","remove","demand","reply","observe"].includes(String(e.type)))requireThat(e.resource===0 || e.resource===1,"TRACE_SCHEMA","invalid history resource");
    if(e.type==="demand")requireThat(["visible","open","cache"].includes(String(e.value)),"TRACE_SCHEMA","invalid history demand");
    if(e.type==="reply")requireThat(["success","retry","terminal"].includes(String(e.outcome)) && (e.oldest===undefined || typeof e.oldest==="boolean"),"TRACE_SCHEMA","invalid history reply");
    if(e.type==="observe")requireThat(["resources","queued","history","history-started","history-authoritative","history-failed","failed","backoff","history-backoff","invalidated"].includes(String(e.at)) && ["remove","dispose","invalidate","replace","retry","join"].includes(String(e.action)),"TRACE_SCHEMA","invalid history observer");
    if(e.type==="tick")requireThat(typeof e.ms==="number" && Number.isFinite(e.ms) && e.ms>=0 && e.ms<=86_400_000,"TRACE_SCHEMA","invalid history elapsed time");
  }
  return value as HistoryChaosEvent[];
}
