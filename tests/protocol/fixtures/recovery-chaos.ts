import { JsonRpcAppServerClient, type AppServerClient, type AppServerClientConfig } from "@opencraft/appserver-client";
import { DeferredDuplexTransport, type DuplexTransport, type TransportStatus } from "@opencraft/appserver-client/transport";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { ConnectionLifecycleOwner, type ConnectionAttempt } from "../../../packages/workbench-runtime/src/connection-lifecycle";
import { createRecoveryNow } from "../../../packages/workbench-runtime/src/recovery-clock";

export type Host = "a" | "b";
export type Boundary = "acquire" | "dial" | "initialize" | "response" | "close";
export type ChaosEvent =
  | { type: "connect" | "hint" | "loss" | "manual" | "dispose" | "late" | "request" | "cancel-request" | "preparing" | "prepared"; host: Host }
  | { type: "hold"; host: Host; boundary: Boundary; value: boolean }
  | { type: "network"; up: boolean }
  | { type: "tick" | "freeze"; ms: number }
  | { type: "stale-timer" | "heal" };
export class ChaosViolation extends Error {
  cleanupFailure?:string;
  constructor(readonly rule: string, detail: string) { super(`${rule}: ${detail}`); }
}
export function requireThat(ok: unknown, rule: string, detail: string): asserts ok {
  if (!ok) throw new ChaosViolation(rule, detail);
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** Timers and elapsed time are controlled independently, as on a frozen page. */
class Clock {
  private raw = 0;
  readonly now = createRecoveryNow(() => this.raw);
  private sequence = 0;
  readonly timers = new Map<number, { at: number; fn(): void }>();
  readonly retired: Array<{at:number;fn():void}> = [];
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.sequence; this.timers.set(id, {at: this.now() + ms, fn}); return id;
  };
  clearTimeout = (value: unknown) => {
    const timer = this.timers.get(value as number);
    if (timer) { this.retired.push(timer); this.timers.delete(value as number); }
  };
  advance(ms: number, timers: boolean) {
    this.raw += ms;
    const now = this.now();
    if (timers) for (const [id, entry] of [...this.timers]) if (entry.at <= now) {
      this.timers.delete(id); this.retired.push(entry); entry.fn();
    }
  }
}
class Wire implements DuplexTransport {
  status: TransportStatus = {state: "idle"};
  readonly messages = new Set<(frame: string) => void>();
  readonly statuses = new Set<(status: TransportStatus) => void>();
  readonly oldMessages: Array<(frame: string) => void> = [];
  readonly oldStatuses: Array<(status: TransportStatus) => void> = [];
  readonly acquired = deferred<DuplexTransport>();
  readonly dial = deferred<void>();
  readonly released = deferred<void>();
  requested = false;
  admitted = false;
  readonly observed = new Set<string>();
  closing = false;
  closed = false;
  open = false;
  readonly requests: Array<{id: string | number; done: boolean; ackLost?: boolean; operation?: Mutation}> = [];
  constructor(readonly world: World, readonly host: Host, readonly id: number) {}
  get tag() { return `chaos-${this.id}`; }
  connect(_signal?: AbortSignal) {
    // A lease is terminal after physical failure. A provider object may be
    // renewable, but this fixture represents the individual acquired lease.
    if (this.closed || this.status.state === "failed") return Promise.reject(new Error("physical lease is terminal"));
    if (this.open && this.status.state === "open") return Promise.resolve();
    this.requested = true; this.publish({state:"connecting"}); return this.dial.promise;
  }
  async send(frame: string) {
    const request = parseJsonRpcMessage(frame);
    requireThat(isJsonRpcRequest(request), "NO_REPLAY", "recovery sent an unexpected frame");
    let operation: Mutation | undefined;
    if (request.method !== "initialize") {
      const id=(request.params as {operationId?: unknown})?.operationId;
      operation=this.world.mutations.find(item=>item.id===id && item.host===this.host);
      requireThat(request.method==="turn/start" && operation, "NO_REPLAY", "recovery sent a mutation without user intent");
      requireThat(++operation.sent===1,"NO_REPLAY",`intent ${operation.id} was sent again`);
      // The synthetic server applies the mutation on receipt; ACK delivery is
      // independently held/lost. Recovery cannot infer that it was never applied.
      this.world.coverage["mutation-applied"]=(this.world.coverage["mutation-applied"]??0)+1;
    }
    this.requests.push({id:request.id,done:false,...(operation?{operation}:{})});
  }
  publish(status: TransportStatus) { this.status = status; for (const fn of this.statuses) fn(status); }
  subscribeMessage(fn: (frame: string) => void) { this.messages.add(fn); this.oldMessages.push(fn); return () => {this.messages.delete(fn);}; }
  subscribeStatus(fn: (status: TransportStatus) => void) { this.statuses.add(fn); this.oldStatuses.push(fn); return () => {this.statuses.delete(fn);}; }
  close() { this.closing = true; return this.released.promise; }
  fail() { if (!this.closed) { this.open = false; this.publish({state:"failed",reason:"synthetic route loss"}); } }
  late() {
    // Captured callbacks represent deliveries already queued before unsubscribe.
    for (const fn of this.oldStatuses) fn({state:"failed",reason:"retired channel"});
    for (const request of this.requests) for (const fn of this.oldMessages)
      fn(encodeJsonRpcMessage({id:request.id,result:request.operation?{operationId:request.operation.id}:this.response()}));
  }
  response() { return {codexHome:"/synthetic",platformFamily:"unix",platformOs:"linux",userAgent:this.tag}; }
}
interface Binding { readonly generation: number; readonly tag: string }
interface Operation { readonly signal: AbortSignal; settled: boolean }
interface Mutation {
  readonly id: number; readonly host: Host; readonly controller: AbortController;
  readonly startedAt: number; deadline: number; preparing: boolean; sent: number;
  settled: boolean; error?: string;
}
interface HostState {
  owner: ConnectionLifecycleOwner<Binding>;
  client: AppServerClient;
  transport: DuplexTransport;
  holds: Record<Boundary, boolean>;
  runs: Operation[];
  ready: number;
}
export interface ChaosOptions {
  createClient?: (config: AppServerClientConfig) => AppServerClient;
  createTransport?: (create: (signal: AbortSignal) => Promise<DuplexTransport>) => DuplexTransport;
  /** Negative control: simulate a client that never releases its first operation. */
  mutant?: "sticky-initialize" | "replay-mutation";
}
class World {
  readonly clock = new Clock();
  readonly hosts = {} as Record<Host,HostState>;
  readonly wires: Wire[] = [];
  readonly mutations: Mutation[] = [];
  network = true;
  private sequence = 0;
  readonly coverage: Record<string,number> = {};
  constructor(options: ChaosOptions) {
    for (const host of ["a","b"] as const) {
      const holds = {acquire:false,dial:false,initialize:false,response:false,close:false};
      const transport = (options.createTransport ?? (create => new DeferredDuplexTransport(create)))(async () => {
        const wire = new Wire(this, host, ++this.sequence); this.wires.push(wire);
        this.coverage["lease-created"]=(this.coverage["lease-created"]??0)+1;
        return wire.acquired.promise;
      });
      if(options.mutant==="replay-mutation") {
        const send=transport.send.bind(transport);
        transport.send=async(frame,signal)=>{
          await send(frame,signal);
          const request=parseJsonRpcMessage(frame);
          if(isJsonRpcRequest(request) && request.method==="turn/start")await send(frame,signal);
        };
      }
      const client = (options.createClient ?? (config => new JsonRpcAppServerClient(config)))({hostId:host,transport,
        requestTimeoutMs:30,clock:this.clock as unknown as AppServerClientConfig["clock"]});
      if (options.mutant==="sticky-initialize") {
        const original = client.connect.bind(client);
        let stuck: ReturnType<typeof client.connect> | undefined;
        client.connect = (...args) => stuck ??= original(...args);
      }
      let state!: HostState;
      const owner = new ConnectionLifecycleOwner<Binding>({clock:this.clock,timeoutMs:60,stageTimeoutMs:25,
        delaysMs:[1,2,4,8],stableMs:50,
        run: async (attempt: ConnectionAttempt) => {
          const operation: Operation = {signal:attempt.signal,settled:false}; state.runs.push(operation);
          try {
            const result = await client.connect({clientInfo:{name:"chaos",version:"1"}},attempt.signal,attempt.assertCurrent);
            return {generation:client.connectionGeneration,tag:result.userAgent};
          } finally { operation.settled = true; }
        },
        valid: binding => client.initializeResult !== null && client.status.state === "open" && binding.generation === client.connectionGeneration,
        invalidate() {},changed() {},usable: () => {
          state.ready++;
          this.coverage["ready-commit"]=(this.coverage["ready-commit"]??0)+1;
        },manual:()=>false,backoff() {},
      });
      state = {owner,client,transport,holds,runs:[],ready:0};this.hosts[host]=state;
      transport.subscribeStatus(status => {
        if (status.state === "failed" || status.state === "closed") owner.lost(new Error("synthetic transport loss"));
      });
      void owner.connect().catch(()=>undefined);
    }
  }
  pump() {
    for (const wire of this.wires) {
      const holds = this.hosts[wire.host].holds;
      const observe = (name: string) => {
        if (wire.observed.has(name)) return;
        wire.observed.add(name);this.coverage[name]=(this.coverage[name]??0)+1;
      };
      if (!wire.admitted) {
        if (holds.acquire) observe("held-acquire");
        else {wire.admitted=true;wire.acquired.resolve(wire);}
      }
      if (wire.closing && !wire.closed && holds.close) observe("held-close");
      if (wire.closing && !holds.close && !wire.closed) {
        wire.closed=true;wire.open=false;wire.released.resolve();wire.publish({state:"closed"});
      }
      if (!wire.closed && !wire.closing && wire.requested && wire.status.state === "connecting" && this.network) {
        // A socket can already exist while the provider handshake is pending.
        // Holding close in this window tests actual physical overlap prevention.
        wire.open=true;observe("physical-open");
        if (!holds.dial) {wire.publish({state:"open"});wire.dial.resolve();}
      }
      if (wire.requested && wire.status.state === "connecting" && holds.dial) observe("held-dial");
      if (wire.open && holds.initialize && wire.requests.some(request=>!request.done)) observe("held-initialize");
      if (wire.open && this.network) for (const request of wire.requests) if (!request.done) {
        if(!request.operation && holds.initialize)continue;
        if (request.operation && holds.response) {observe("held-response");continue;}
        request.done=true;
        if(request.operation)this.coverage["mutation-ack"]=(this.coverage["mutation-ack"]??0)+1;
        const frame=encodeJsonRpcMessage({id:request.id,result:request.operation?{operationId:request.operation.id}:wire.response()});
        for (const fn of wire.messages) fn(frame);
      }
    }
  }
  async settle() { for (let i=0;i<4;i++) {this.pump();await flush();} this.check(); }
  check() {
    requireThat(this.clock.timers.size<=8,"TIMER_BOUND",`active timers ${this.clock.timers.size}`);
    for(const operation of this.mutations) {
      requireThat(operation.sent<=1,"NO_REPLAY",`intent ${operation.id} duplicated`);
      requireThat(operation.error!=="EARLY_TIMEOUT","RPC_DEADLINE",`intent ${operation.id} timed out before its current deadline`);
      requireThat(operation.error!=="WRONG_RESPONSE","RPC_CORRELATION",`intent ${operation.id} received another intent's response`);
      if(operation.controller.signal.aborted)requireThat(operation.settled,"LOCAL_CANCELLATION",`intent ${operation.id} did not settle on cancellation`);
    }
    for (const host of ["a","b"] as const) {
      const state=this.hosts[host],snapshot=state.owner.snapshot;
      const physical=this.wires.filter(w=>w.host===host && w.open && !w.closed);
      requireThat(physical.length<=1,"PHYSICAL_SERIALIZATION",`${host} owns ${physical.length} open channels`);
      if (snapshot.phase === "usable") {
        requireThat(state.client.initializeResult!==null && snapshot.binding?.generation===state.client.connectionGeneration,"CURRENT_AUTHORITY",`${host} usable without current initialization`);
        requireThat(physical.some(w=>w.tag===snapshot.binding?.tag),"CURRENT_AUTHORITY",`${host} committed a retired channel`);
      }
      for (const operation of state.runs) if (operation.signal.aborted)
        requireThat(operation.settled,"LOCAL_CANCELLATION",`${host} revoked initialization still owns its local Promise`);
    }
  }
  async apply(event: ChaosEvent) {
    this.coverage[event.type]=(this.coverage[event.type]??0)+1;
    const previous=Object.fromEntries((["a","b"] as const).map(h=>[h,this.hosts[h].owner.snapshot]));
    if (event.type==="tick" || event.type==="freeze") this.clock.advance(event.ms,event.type==="tick");
    else if (event.type==="network") {
      this.network=event.up;
      if (!event.up) for (const wire of this.wires) if (wire.requested) {
        for(const request of wire.requests)if(request.operation && !request.done && !request.ackLost) {
          request.ackLost=true;
          this.coverage["mutation-ack-lost"]=(this.coverage["mutation-ack-lost"]??0)+1;
        }
        wire.fail();
      }
    } else if (event.type==="hold") this.hosts[event.host].holds[event.boundary]=event.value;
    else if (event.type==="stale-timer") {
      const queued=[...this.clock.retired].reverse().find(timer=>timer.at<=this.clock.now());
      if(queued) {this.coverage["queued-timer-delivered"]=(this.coverage["queued-timer-delivered"]??0)+1;queued.fn();}
    }
    else if (event.type==="heal") {
      this.network=true;
      for (const state of Object.values(this.hosts)) for (const boundary of ["acquire","dial","initialize","response","close"] as const) state.holds[boundary]=false;
      for (let i=0;i<30;i++) {this.clock.advance(10,true);await this.settle();}
      for (const [host,state] of Object.entries(this.hosts)) if (!["blocked","disposed"].includes(state.owner.snapshot.phase))
        requireThat(state.owner.snapshot.phase==="usable","EVENTUAL_RECOVERY",`${host} did not recover in 300 virtual ms after faults stopped`);
    } else if ("host" in event) {
      const state=this.hosts[event.host];
      const mutation=[...this.mutations].reverse().find(item=>item.host===event.host && !item.settled);
      if(event.type==="request" && !mutation && state.owner.snapshot.phase==="usable") {
        const operation:Mutation={id:this.mutations.length+1,host:event.host,controller:new AbortController(),startedAt:this.clock.now(),
          deadline:this.clock.now()+30,preparing:false,sent:0,settled:false};
        this.mutations.push(operation);
        void state.client.requestRaw("turn/start",{threadId:`chaos-thread-${event.host}`,input:[],operationId:operation.id},{signal:operation.controller.signal})
          .then(result=>{
            operation.settled=true;
            if((result as {operationId?: unknown})?.operationId!==operation.id)operation.error="WRONG_RESPONSE";
          },error=>{
            operation.settled=true;
            operation.error=error?.code==="TIMEOUT" && this.clock.now()<operation.deadline?"EARLY_TIMEOUT":String(error?.code);
          });
      }
      if(event.type==="cancel-request")mutation?.controller.abort();
      if((event.type==="preparing" || event.type==="prepared") && mutation) {
        if(event.type==="preparing" && !mutation.preparing) {
          mutation.preparing=true;mutation.deadline=mutation.startedAt+180_000;
          this.coverage["rpc-deadline-extended"]=(this.coverage["rpc-deadline-extended"]??0)+1;
        } else if(event.type==="prepared" && mutation.preparing) {
          mutation.deadline=Math.min(mutation.startedAt+180_000,this.clock.now()+30);
          this.coverage["rpc-deadline-shortened"]=(this.coverage["rpc-deadline-shortened"]??0)+1;
        }
        const notification=event.type==="preparing"
          ? {method:"item/started",params:{threadId:`chaos-thread-${event.host}`,turnId:`prepare-${mutation.id}`,item:{type:"contextCompaction"}}}
          : {method:"turn/completed",params:{threadId:`chaos-thread-${event.host}`,turn:{id:`prepare-${mutation.id}`}}};
        for(const wire of this.wires)if(wire.host===event.host && wire.open && !wire.closing)
          for(const fn of wire.messages)fn(encodeJsonRpcMessage(notification));
      }
      if (event.type==="connect") void state.owner.connect(true).catch(()=>undefined);
      if (event.type==="hint" && state.owner.admitRecoveryHint()) void state.owner.connect(true).catch(()=>undefined);
      if (event.type==="loss" || event.type==="manual") state.owner.lost(new Error("synthetic host failure"),event.type==="manual");
      if (event.type==="dispose") { state.owner.dispose();void state.client.close().catch(()=>undefined); }
      if (event.type==="late") for (const wire of this.wires) if (wire.host===event.host && (wire.closing || wire.closed)) wire.late();
    }
    await this.settle();
    for (const host of ["a","b"] as const) {
      if (previous[host].phase==="disposed") requireThat(this.hosts[host].owner.snapshot.phase==="disposed","DISPOSE_TERMINAL",host);
      if (previous[host].phase==="blocked" && !(event.type==="connect" && event.host===host) && !(event.type==="dispose" && event.host===host))
        requireThat(this.hosts[host].owner.snapshot.phase==="blocked","MANUAL_STICKY",host);
      if ((event.type==="loss" || event.type==="manual") && event.host!==host && previous[host].phase==="usable")
        requireThat(this.hosts[host].owner.snapshot.binding===previous[host].binding,"HOST_ISOLATION",host);
    }
  }
  async close() {
    for (const state of Object.values(this.hosts)) {
      for (const boundary of ["acquire","dial","initialize","response","close"] as const) state.holds[boundary]=false;
      state.owner.dispose();void state.client.close().catch(()=>undefined);
    }
    for (let i=0;i<4;i++) {this.pump();await flush();}
    requireThat(this.clock.timers.size===0,"CLEANUP",`${this.clock.timers.size} leaked timers`);
    requireThat(this.wires.every(wire=>wire.closed),"CLEANUP","a retired physical lease was not released");
    requireThat(this.mutations.every(item=>item.settled),"CLEANUP","an issued mutation still owns its local Promise");
  }
}
export interface ChaosResult { events: number; wires: number; ready: number; coverage: Record<string,number> }
export async function simulateRecovery(events: readonly ChaosEvent[],options: ChaosOptions={}): Promise<ChaosResult> {
  const world=new World(options);
  let failure:unknown;
  try {
    await world.settle();
    for (const event of events) await world.apply(event);
    // Every trace ends with an explicit quiescent suffix, even when fuzz omits it.
    await world.apply({type:"heal"});
    return {events:events.length,wires:world.wires.length,ready:Object.values(world.hosts).reduce((n,s)=>n+s.ready,0),coverage:world.coverage};
  } catch(error) {failure=error;throw error;}
  finally {
    try {await world.close();}catch(error){
      if(failure===undefined)throw error;
      if(failure instanceof ChaosViolation)failure.cleanupFailure=error instanceof Error?error.message:String(error);
    }
  }
}
export function recoveryChaosRandom(seed: number) {
  let value=seed>>>0;
  return () => {value=(value+0x6D2B79F5)>>>0;let t=Math.imul(value^(value>>>15),1|value);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
}
export function generateRecoveryChaos(seed: number,steps=120): ChaosEvent[] {
  const rng=recoveryChaosRandom(seed),pick=<T>(values:readonly T[]):T=>values[Math.floor(rng()*values.length)]!;
  const events:ChaosEvent[]=[];
  for (let i=0;i<steps;i++) {
    const host=pick(["a","b"] as const);
    const type=pick(["connect","hint","loss","late","hold","hold","tick","freeze","network","stale-timer","manual","dispose","request","request","cancel-request","preparing","prepared"] as const);
    if (i%32===31) events.push({type:"heal"});
    if (type==="hold") events.push({type,host,boundary:pick(["acquire","dial","initialize","response","close"] as const),value:rng()<0.6});
    else if(type==="tick" || type==="freeze") events.push({type,ms:pick([0,1,10,26,61,5_001])});
    else if(type==="network") events.push({type,up:rng()<0.6});
    else if(type==="stale-timer") events.push({type});
    // Terminal disposal is sampled late so repeated recovery remains exercised.
    else if(type==="dispose" && i<steps*0.8) events.push({type:"loss",host});
    else events.push({type,host});
  }
  return events;
}
/** Delta debugging preserves the SAME rule and a replayable explicit event list. */
export async function shrinkRecoveryFailure(events: readonly ChaosEvent[],rule:string,options:ChaosOptions={},limit=100):Promise<ChaosEvent[]> {
  return shrinkChaosFailure(events,rule,trace=>simulateRecovery(trace,options),limit);
}
export async function shrinkChaosFailure<T>(events:readonly T[],rule:string,run:(events:readonly T[])=>Promise<unknown>,limit=100):Promise<T[]> {
  let current=[...events],size=Math.max(1,Math.floor(current.length/2)),attempts=0;
  while(size>=1 && attempts<limit) {
    let removed=false;
    for(let i=0;i<current.length && attempts<limit;i+=size) {
      const candidate=[...current.slice(0,i),...current.slice(i+size)];attempts++;
      try {await run(candidate);} catch(error) {
        if(error instanceof ChaosViolation && error.rule===rule){current=candidate;removed=true;break;}
      }
    }
    if(!removed) size=Math.floor(size/2);
  }
  return current;
}
export function parseRecoveryTrace(value:unknown):ChaosEvent[] {
  requireThat(Array.isArray(value) && value.length<=10_000,"TRACE_SCHEMA","expected at most 10000 events");
  for(const event of value) {
    requireThat(typeof event==="object" && event!==null,"TRACE_SCHEMA","invalid event");
    const e=event as Record<string,unknown>;
    requireThat(["connect","hint","loss","manual","dispose","late","hold","network","tick","freeze","stale-timer","heal","request","cancel-request","preparing","prepared"].includes(String(e.type)),"TRACE_SCHEMA","unknown event type");
    if(["connect","hint","loss","manual","dispose","late","hold","request","cancel-request","preparing","prepared"].includes(String(e.type))) requireThat(e.host==="a" || e.host==="b","TRACE_SCHEMA","invalid host");
    if(e.type==="tick" || e.type==="freeze") requireThat(typeof e.ms==="number" && Number.isFinite(e.ms) && e.ms>=0 && e.ms<=86_400_000,"TRACE_SCHEMA","invalid elapsed time");
    if(e.type==="network") requireThat(typeof e.up==="boolean","TRACE_SCHEMA","invalid network flag");
    if(e.type==="hold") requireThat(["acquire","dial","initialize","response","close"].includes(String(e.boundary)) && typeof e.value==="boolean","TRACE_SCHEMA","invalid hold boundary");
  }
  return value as ChaosEvent[];
}
