import type { AppHostServer } from '@opencraft/app-host-server';
import { hostCleanupFixture, cleanupClient, flushCleanup, trackCleanup, type CleanupMode } from './host-cleanup';
import { ChaosViolation, requireThat } from './recovery-chaos';
export type CleanupEvent = { type: 'setup'; path: 'normal'|'startup'|'shutdown'; lifetime: 'last-claim'|'server'; mode: CleanupMode; detachFailure: boolean; subscriptionFailure: boolean }
  | { type: 'mode'; mode: CleanupMode }
  | { type: 'open'|'retire'|'retry'|'release-close'|'detach-ok'|'old-status'|'probe'|'observe'|'heal' };
export type CleanupMutant = 'orphan-handle'|'false-shutdown'|'bypass-barrier';
const modes = ['success','reject','throw','reject-released','hold'] as const;
export function parseCleanupTrace(value: unknown): CleanupEvent[] {
  requireThat(Array.isArray(value)&&value.length<=10000,'TRACE_SCHEMA','expected at most 10000 cleanup events');
  for(const item of value){
    requireThat(typeof item==='object'&&item!==null,'TRACE_SCHEMA','invalid cleanup event');const e=item as Record<string,unknown>;
    requireThat(['setup','mode','open','retire','retry','release-close','detach-ok','old-status','probe','observe','heal'].includes(String(e.type)),'TRACE_SCHEMA','invalid cleanup discriminant');
    if(e.type==='setup')requireThat(['normal','startup','shutdown'].includes(String(e.path))&&['last-claim','server'].includes(String(e.lifetime))&&typeof e.detachFailure==='boolean'&&typeof e.subscriptionFailure==='boolean','TRACE_SCHEMA','invalid cleanup composition');
    if(e.type==='mode'||e.type==='setup')requireThat(modes.includes(e.mode as CleanupMode),'TRACE_SCHEMA','invalid physical close outcome');
  }
  return value as CleanupEvent[];
}
export function generateCleanupChaos(seed:number,steps:number):CleanupEvent[]{
  let state=seed>>>0;const next=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state>>>8;};
  const path=(['normal','startup','shutdown'] as const)[next()%3]!;
  const events:CleanupEvent[]=[{type:'setup',path,lifetime:next()%2?'server':'last-claim',mode:modes[next()%modes.length]!,detachFailure:next()%4===0,subscriptionFailure:path==='startup'&&next()%2===0},{type:'open'},{type:'probe'},{type:'retire'}];
  for(let i=0;i<steps;i++){
    const choice=next()%12;if(choice<3)events.push({type:'mode',mode:modes[next()%modes.length]!});
    else events.push({type:(['open','retry','release-close','detach-ok','old-status','probe','observe','retire','heal'] as const)[choice-3]!});
  }
  events.push({type:'heal'});return events;
}
/** One physical Host, all three cleanup paths. Input predicts ownership,
 * provider resources, cleanup attempts and local outcomes independently of labels.
 * Held-start cancellation and multi-Host routing are separate component suites. */
export async function simulateHostCleanup(events:readonly CleanupEvent[],options:{mutant?:CleanupMutant;Server?:typeof AppHostServer;onFailure?:(failure:ChaosViolation)=>void}={}){
  type Page={transport:ReturnType<ReturnType<typeof hostCleanupFixture>['channel']>;client:ReturnType<typeof cleanupClient>};
  type Resource={released:boolean;mode:CleanupMode;detachFailure:boolean;pendingDetachers:number;messagePending:boolean;detaches:number;calls:number;gateReleased:boolean;startup:boolean};
  type Wait={track:ReturnType<typeof trackCleanup>;expected:string;manual:boolean;kind:'open'|'close'|'reset'|'shutdown'};
  let f:ReturnType<typeof hostCleanupFixture>|undefined,setup:Extract<CleanupEvent,{type:'setup'}>|undefined;
  type Phase='none'|'live'|'closing'|'failed'|'clean';
  let phase:Phase='none',stopped=false,healthyFuture=false,logicalStartupFailure=false;
  let primary:Page|undefined,blocked:{page:Page;wait:Wait;revoked:boolean}|undefined;let current=-1,closeAttemptDetachFailed=false;
  const resources:Resource[]=[],waits:Wait[]=[],pages:Page[]=[],revokedWaits:Wait[]=[];let cleanupWaits:Wait[]=[];let resetPending=false;
  const coverage:Record<string,number>={};const metrics={events:events.length,connectIntents:0,connectSettled:0,cleanupCalls:0,nativeEvents:0,rpcIntents:0,rpcFrames:0,heals:0,coverage};
  const inPhase=(value:Phase)=>phase===value;
  const hit=(name:string)=>{coverage[name]=(coverage[name]??0)+1;};
  const wait=(promise:Promise<unknown>,kind:Wait['kind'],expected:string,manual=false)=>{const value:Wait={track:trackCleanup(promise),expected,kind,manual};waits.push(value);return value;};
  const page=():Page=>{const transport=f!.channel(),value={transport,client:cleanupClient(transport)};pages.push(value);return value;};
  const allocate=()=>{
    const initial=resources.length===0&&!healthyFuture;
    const startup=initial&&setup!.path==='startup';
    const resource:Resource={released:false,mode:initial?setup!.mode:'success',detachFailure:initial&&setup!.detachFailure,pendingDetachers:startup&&setup!.subscriptionFailure?1:2,messagePending:true,detaches:0,calls:0,gateReleased:false,startup};
    resources.push(resource);current=resources.length-1;logicalStartupFailure=startup;return resource;
  };
  const cleanupAttempt=(): 'closing'|'failed'|'clean'=>{
    const resource=resources[current]!;resource.calls++;metrics.cleanupCalls++;
    resource.detaches+=resource.pendingDetachers;
    closeAttemptDetachFailed=resource.detachFailure&&resource.messagePending;
    resource.pendingDetachers=closeAttemptDetachFailed?1:0;resource.messagePending=closeAttemptDetachFailed;
    if(resource.mode==='hold'&&!resource.gateReleased)return 'closing';
    if(resource.mode==='success'||resource.mode==='reject-released'||resource.mode==='hold')resource.released=true;
    return closeAttemptDetachFailed||resource.mode==='reject'||resource.mode==='throw'||resource.mode==='reject-released'?'failed':'clean';
  };
  const registerOpen=async()=>{
    if(!f)return;
    metrics.connectIntents++;
    if(stopped){wait(f.server.ensureHostConnected('a'),'open','rejected');return;}
    if(phase==='closing'){
      if(blocked&&!blocked.revoked){hit('open.already-waiting');metrics.connectIntents--;return;}
      if(blocked)revokedWaits.push(blocked.wait);
      const p=page();blocked={page:p,wait:wait(p.transport.connect(),'open','pending'),revoked:false};return;
    }
    if(phase==='failed'){const p=page();wait(p.transport.connect(),'open','rejected',true);return;}
    if(phase==='live'&&primary){wait(primary.transport.connect(),'open','resolved');return;}
    const p=page();primary=p;const resource=allocate();
    if(resource.startup){phase=cleanupAttempt();const w=wait(p.transport.connect(),'open',phase==='closing'?'pending':'rejected',phase==='failed');if(phase==='closing')cleanupWaits.push(w);}
    else{phase='live';wait(p.transport.connect(),'open','resolved');}
  };
  const finishClosing=()=>{
    const resource=resources[current]!;resource.released=true;resource.gateReleased=true;
    phase=closeAttemptDetachFailed?'failed':'clean';
    for(const w of cleanupWaits){w.expected=w.kind==='open'?'rejected':w.kind==='close'?'resolved':phase==='failed'?'rejected':'resolved';w.manual=w.expected==='rejected'&&phase==='failed';}
    cleanupWaits=[];
    for(const w of revokedWaits){w.expected='rejected';w.manual=phase==='failed';}
    revokedWaits.length=0;
    if(blocked){
      if(phase==='failed'||blocked.revoked){blocked.wait.expected='rejected';blocked.wait.manual=phase==='failed';}
      else{primary=blocked.page;allocate();phase='live';blocked.wait.expected='resolved';}
      blocked=undefined;
    }
    resetPending=false;
  };
  const retire=async(retry:boolean)=>{
    if(!f)return;
    if(phase==='none'||phase==='clean'){
      if(stopped){wait(f.server.close(),'shutdown','resolved');}
      return;
    }
    if(phase==='failed'&&!retry){hit('retire.failed-needs-explicit-retry');return;}
    const alreadyClosing=phase==='closing';
    if(alreadyClosing&&!retry){hit('retire.already-closing');return;}
    if(!alreadyClosing)phase=cleanupAttempt();
    const kind:Wait['kind']=stopped||setup!.path==='shutdown'?'shutdown':retry||setup!.lifetime==='server'?'reset':'close';
    if(kind==='shutdown')stopped=true;
    if(kind==='reset'){
      logicalStartupFailure=false;
      if(alreadyClosing&&!resetPending&&blocked)blocked.revoked=true;
      resetPending=phase==='closing';
    }
    primary=undefined;
    const expected=phase==='closing'?'pending':kind==='close'?'resolved':phase==='failed'?'rejected':'resolved';
    const promise=kind==='shutdown'?f.server.close():kind==='reset'?f.server.resetHost('a'):pages.at(-1)!.transport.close();
    const w=wait(promise,kind,expected,expected==='rejected');if(alreadyClosing||phase==='closing')cleanupWaits.push(w);
  };
  const check=async()=>{
    await flushCleanup();if(!f)return;
    requireThat(f.physicals.length===resources.length,'CLEANUP_FACTORY_ADMISSION','new factory crossed a retained physical cleanup owner');
    const live=f.physicals.filter(p=>!p.released).length+(options.mutant==='bypass-barrier'&&phase==='closing'?1:0);
    requireThat(live<=1,'CLEANUP_PHYSICAL_EXCLUSIVITY','more than one physical resource remains live');
    for(let i=0;i<resources.length;i++){
      const expected=resources[i]!,actual=f.physicals[i]!;
      requireThat(actual.released===expected.released&&actual.closeCalls===expected.calls,'CLEANUP_RELEASE_ACCOUNTING',`physical ${i} actual=${JSON.stringify({released:actual.released,calls:actual.closeCalls})} expected=${JSON.stringify({released:expected.released,calls:expected.calls})} phase=${phase}`);
      requireThat(actual.detachCalls===expected.detaches,'CLEANUP_DETACH_CONSERVATION',`physical ${i} lost or repeated a captured disposer`);
    }
    let host=f.server.hostState('a');if(options.mutant==='orphan-handle'&&phase==='failed')host='closed';
    const expectedHost=phase==='none'?'idle':phase==='live'?'open':phase==='closing'?'closing':phase==='failed'?'failed':stopped?'idle':logicalStartupFailure?'failed':'closed';
    requireThat(host===expectedHost,'CLEANUP_HANDLE_CONSERVATION',`expected owned ${expectedHost}, got ${host}`);
    for(const w of waits){
      const observed=options.mutant==='false-shutdown'&&w.kind==='shutdown'&&w.expected==='rejected'?'resolved':w.track.state;
      requireThat(observed===w.expected,'CLEANUP_OUTCOME',`${w.kind}: expected ${w.expected}, got ${observed}`);
      if(w.manual)requireThat((w.track.error as {code?:string;retryable?:boolean})?.code==='APP_HOST_CLEANUP_FAILED'&&(w.track.error as {retryable?:boolean}).retryable===false,'CLEANUP_FAILURE_CLASSIFICATION','cleanup failure lost its manual disposition');
    }
    if(stopped&&waits.some(w=>w.kind==='shutdown'&&w.track.state!=='pending'))f.bridge.close();
  };
  const probe=async()=>{
    if(!primary||phase!=='live'||stopped){hit('probe.not-live');return;}
    metrics.rpcIntents++;const token=metrics.rpcIntents;let outcome='pending',value:unknown;
    const operation=primary.client.connect({clientInfo:{name:'cleanup-chaos',version:'1'}}).then(()=>primary!.client.requestRaw('echo',{token})).then(result=>{outcome='resolved';value=result;},()=>{outcome='rejected';});
    await flushCleanup();requireThat(outcome==='resolved'&&JSON.stringify(value)===JSON.stringify({token}),'CLEANUP_RPC_PROGRESS','actual current Client did not initialize and echo');await operation;metrics.rpcFrames++;
  };
  let failure:unknown;
  try{
    for(const event of events){
      hit(event.type);
      if(event.type==='setup'){
        if(f){hit('setup.ignored');continue;}setup=event;
        f=hostCleanupFixture({lifetime:event.lifetime,Server:options.Server,onCreate(p,index){
          if(index===0&&!healthyFuture){p.mode=event.mode;p.throwMessageDetach=event.detachFailure;p.failStart=event.path==='startup'&&!event.subscriptionFailure;p.throwStatusSubscription=event.path==='startup'&&event.subscriptionFailure;}
        }});continue;
      }
      if(!f)continue;
      if(event.type==='open')await registerOpen();
      else if(event.type==='retire')await retire(false);
      else if(event.type==='retry')await retire(true);
      else if(event.type==='mode'&&current>=0){resources[current]!.mode=event.mode;f.physicals[current]!.mode=event.mode;}
      else if(event.type==='detach-ok'&&current>=0){resources[current]!.detachFailure=false;f.physicals[current]!.throwMessageDetach=false;}
      else if(event.type==='release-close'&&inPhase('closing')){const index=current;finishClosing();f.physicals[index]!.closeGate.resolve();}
      else if(event.type==='old-status'){for(const p of f.physicals.slice(0,-1))p.statusCallbacks[0]?.({state:'failed'});metrics.nativeEvents++;}
      else if(event.type==='probe')await probe();
      else if(event.type==='heal'){
        healthyFuture=true;
        if(current>=0){resources[current]!.mode='success';resources[current]!.detachFailure=false;f.physicals[current]!.mode='success';f.physicals[current]!.throwMessageDetach=false;}
        if(inPhase('closing')){const index=current;finishClosing();f.physicals[index]!.closeGate.resolve();await check();}
        if(inPhase('failed')||inPhase('live'))await retire(true);
        await check();
        if(!stopped){await registerOpen();await check();await probe();}
        metrics.heals++;
      }
      await check();
    }
    metrics.connectSettled=waits.filter(w=>w.kind==='open'&&w.expected!=='pending').length;
  }catch(error){
    failure=error;
    // Old implementations can keep recursive cleanup microtasks alive. An
    // isolated comparison worker may synchronously save this primary oracle
    // before exiting its own in-memory fixture process; ordinary runs clean up.
    if(error instanceof ChaosViolation&&options.onFailure)try{options.onFailure(error);}catch(receiptError){error.cleanupFailure=String(receiptError);}
  }
  try{if(f)await f.close();}catch(error){const detail=error instanceof Error?error.message:String(error);if(failure instanceof ChaosViolation)failure.cleanupFailure=detail;else if(!failure)failure=new ChaosViolation('CLEANUP_TEARDOWN',detail);}
  if(failure)throw failure;return metrics;
}
