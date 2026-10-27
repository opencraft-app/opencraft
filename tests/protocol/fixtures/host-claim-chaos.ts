import type { AppHostServer } from '@opencraft/app-host-server';
import type { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { hostClaimFixture, flushClaims, heldForwardingFrame, claimInitialize, type ClaimChannel } from './host-claims';
import { ChaosViolation, requireThat } from './recovery-chaos';
export type ClaimEvent = { type: 'setup'; lifetime: 'last-claim' | 'server'; maxPending: number }
  | { type: 'open' | 'close' | 'hold' | 'echo'; slot: number }
  | { type: 'settle'; index: number; failure: boolean }
  | { type: 'cycle' | 'withhold-release' | 'release-acks' | 'fresh-page' | 'heal' };
export type ClaimMutant = 'leak-old' | 'retarget-peer' | 'wait-cleanup-ack';
export function parseClaimTrace(value: unknown): ClaimEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 claim events');
  for (const item of value) {
    requireThat(typeof item === 'object' && item !== null, 'TRACE_SCHEMA', 'invalid claim event');
    const e = item as Record<string, unknown>;
    requireThat(['setup','open','close','hold','echo','settle','cycle','withhold-release','release-acks','fresh-page','heal'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid claim discriminant');
    if (e.type === 'setup') requireThat(['last-claim','server'].includes(String(e.lifetime)) && Number.isInteger(e.maxPending) && Number(e.maxPending) >= 1 && Number(e.maxPending) <= 8, 'TRACE_SCHEMA', 'invalid claim composition');
    if (['open','close','hold','echo'].includes(String(e.type))) requireThat(Number.isInteger(e.slot) && Number(e.slot) >= 0 && Number(e.slot) < 3, 'TRACE_SCHEMA', 'invalid channel slot');
    if (e.type === 'settle') requireThat(Number.isInteger(e.index) && Number(e.index) >= 0 && Number(e.index) < 10000 && typeof e.failure === 'boolean', 'TRACE_SCHEMA', 'invalid held outcome');
  }
  return value as ClaimEvent[];
}
export function generateClaimChaos(seed: number, steps: number): ClaimEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(1664525,state)+1013904223)>>>0;return state>>>8; };
  const events: ClaimEvent[] = [{ type:'setup',lifetime:next()%2?'server':'last-claim',maxPending:next()%2?1:8 }];
  for(let i=0;i<steps;i++) {
    const choice=next()%14,slot=next()%3;
    if(choice<3)events.push({type:'open',slot});
    else if(choice<5)events.push({type:'close',slot});
    else if(choice<7)events.push({type:'hold',slot});
    else if(choice<9)events.push({type:'settle',index:next()%10000,failure:!!(next()%2)});
    else if(choice===9)events.push({type:'echo',slot});
    else events.push({type:(['cycle','withhold-release','release-acks','fresh-page'] as const)[choice-10]!});
  }
  events.push({type:'heal'},{type:'close',slot:0},{type:'close',slot:1},{type:'close',slot:2},{type:'release-acks'});return events;
}
/** The saved input ledger owns expected remote reservations, release counts,
 * physical lifetime, FIFO admissions and local outcomes. Labels do not heal it. */
export async function simulateHostClaims(events: readonly ClaimEvent[], options: { mutant?: ClaimMutant; Server?: typeof AppHostServer; Client?: typeof MessagePortAppHostClient } = {}) {
  type Channel = { page: ClaimChannel; live: boolean; closed: boolean; remote: boolean };
  type Wait = { tag: string; slot: number; admitted: boolean; nativeDone: boolean; retired: boolean; expected: string; actual: string; physical: number };
  let f: ReturnType<typeof hostClaimFixture> | undefined, r: ReturnType<ReturnType<typeof hostClaimFixture>['renderer']> | undefined;
  let lifetime: 'last-claim'|'server'='last-claim', maxPending=8, factories=0, closes=0, expectedReleases=0, renewed=false;
  const channels: (Channel|undefined)[] = [], waits: Wait[] = []; let queue: Wait[]=[];
  const admitted=new Set<string>(), coverage: Record<string,number>={};
  const metrics={events:events.length,connectIntents:0,connectSettled:0,sendIntents:0,sendSettled:0,nativeAdmissions:0,nativeEvents:0,rpcIntents:0,rpcFrames:0,heals:0,cleanupCalls:0,coverage};
  const hit=(key:string)=>{coverage[key]=(coverage[key]??0)+1;};
  const remoteCount=()=>channels.filter(c=>c?.remote).length;
  const ordinaryBusy=()=>waits.filter(w=>w.expected==='pending').length;
  const admitHead=()=>{const head=queue[0];if(head&&!head.admitted){head.admitted=true;head.physical=factories-1;admitted.add(head.tag);metrics.nativeAdmissions++;}};
  const retireWaits=(slot?:number)=>{
    for(const wait of queue)if(slot===undefined||wait.slot===slot){wait.retired=true;wait.expected='rejected';metrics.sendSettled++;}
    queue=queue.filter(w=>!w.retired);admitHead();
  };
  const check=async()=>{
    await flushClaims();if(!f||!r)return;
    let observed=r.wire.filter(m=>m.type==='host/disconnect').length;
    if(options.mutant==='leak-old'&&renewed)observed--;
    requireThat(observed===expectedReleases,'CLAIM_REMOTE_RECLAMATION',`expected ${expectedReleases} releases, got ${observed}`);
    requireThat(f.physicals.length===factories&&f.physicals.reduce((n,p)=>n+p.closeCalls,0)===closes,'CLAIM_PHYSICAL_LIFETIME','remote claims and actual physical lifetime diverged');
    const actual=f.physicals.flatMap(p=>p.held.map(w=>w.tag));
    requireThat(JSON.stringify([...actual].sort())===JSON.stringify([...admitted].sort()),'CLAIM_ADMISSION','retired or queued frame crossed native admission');
    for(const wait of waits)requireThat(wait.actual===wait.expected,'CLAIM_WAIT_OWNERSHIP',`${wait.tag}: ${wait.actual}, expected ${wait.expected}`);
    for(const c of channels)if(c?.live)requireThat(c.page.transport.status.state==='open','CLAIM_PEER_OWNERSHIP','a live peer lost its own grant');
  };
  const open=async(slot:number)=>{
    if(!f||!r)return;
    let channel=channels[slot];if(channel?.live)return;
    if(ordinaryBusy()>=maxPending){hit('open.input-backpressure');return;}
    if(!channel||channel.closed){channel={page:r.channel(),live:false,closed:false,remote:false};channels[slot]=channel;}
    const previous=channel.remote;
    if(remoteCount()===0&&(lifetime==='last-claim'||factories===0))factories++;
    if(previous){expectedReleases++;metrics.cleanupCalls++;renewed=true;}
    channel.remote=true;channel.live=true;metrics.connectIntents++;
    let outcome='pending';const operation=channel.page.transport.connect().then(()=>{outcome='resolved';},()=>{outcome='rejected';});
    await flushClaims();if(options.mutant==='wait-cleanup-ack'&&r.heldReplies.length)outcome='pending';
    requireThat(outcome==='resolved','CLAIM_CONNECT_PROGRESS','fresh own grant depended on an obsolete cleanup ACK');
    await operation;metrics.connectSettled++;
  };
  const echo=async(channel:Channel)=>{
    metrics.rpcIntents++;const token=metrics.rpcIntents;let outcome='pending',value:unknown;
    const operation=channel.page.client.connect(claimInitialize).then(()=>channel.page.client.requestRaw('echo',{token})).then(result=>{outcome='resolved';value=result;},()=>{outcome='rejected';});
    await flushClaims();requireThat(outcome==='resolved'&&JSON.stringify(value)===JSON.stringify({token}),'CLAIM_RPC_PROGRESS','actual initialized Client did not return its own echo');
    await operation;metrics.rpcFrames++;
  };
  const settle=async(wait:Wait,failure:boolean)=>{
    if(!wait.admitted||wait.nativeDone)return;
    wait.nativeDone=true;f!.physicals[wait.physical]!.settle(wait.tag,failure);
    if(!wait.retired){wait.expected=failure?'rejected':'resolved';metrics.sendSettled++;queue=queue.filter(w=>w!==wait);admitHead();}
    await flushClaims();
  };
  let failure: unknown;
  try {
    for(const event of events){
      hit(event.type);
      if(event.type==='setup'){
        if(f){hit('setup.ignored');continue;}
        lifetime=event.lifetime;maxPending=event.maxPending;
        f=hostClaimFixture({lifetime,maxPending,Server:options.Server,Client:options.Client});r=f.renderer();continue;
      }
      if(!f||!r)continue;
      if(event.type==='open')await open(event.slot);
      else if(event.type==='cycle'){
        if(remoteCount()===0){hit('cycle.no-claims');continue;}
        f.physical.publish({state:'closed'});f.physical.publish({state:'open'});metrics.nativeEvents+=2;
        retireWaits();for(const channel of channels)if(channel)channel.live=false;
      }else if(event.type==='close'){
        const c=channels[event.slot];if(!c||c.closed)continue;
        c.closed=true;c.live=false;retireWaits(event.slot);
        if(c.remote){c.remote=false;expectedReleases++;metrics.cleanupCalls++;if(remoteCount()===0&&lifetime==='last-claim')closes++;}
        void c.page.transport.close().catch(()=>{});
        if(options.mutant==='retarget-peer'&&channels.some(other=>other?.live))throw new ChaosViolation('CLAIM_PEER_OWNERSHIP','tool observation retired a peer');
      }else if(event.type==='hold'){
        const c=channels[event.slot];if(!c?.live||ordinaryBusy()>=maxPending){hit('hold.not-admitted');continue;}
        const wait:Wait={tag:`claim-${waits.length}`,slot:event.slot,admitted:false,nativeDone:false,retired:false,expected:'pending',actual:'pending',physical:-1};
        waits.push(wait);queue.push(wait);admitHead();metrics.sendIntents++;
        void c.page.transport.send(heldForwardingFrame(wait.tag)).then(()=>{wait.actual='resolved';},()=>{wait.actual='rejected';});
      }else if(event.type==='settle'){
        const available=waits.filter(w=>w.admitted&&!w.nativeDone);if(available.length)await settle(available[event.index%available.length]!,event.failure);
      }else if(event.type==='withhold-release')r.withheld.add('host/disconnect');
      else if(event.type==='release-acks'){r.withheld.clear();r.releaseReplies();}
      else if(event.type==='echo'){
        const c=channels[event.slot];if(c?.live&&queue.length===0&&ordinaryBusy()<maxPending)await echo(c);else hit('echo.valid-fifo-wait');
      }else if(event.type==='fresh-page'){
        const fresh=f.renderer(),page=fresh.channel();
        if(remoteCount()===0&&(lifetime==='last-claim'||factories===0))factories++;
        await page.client.connect(claimInitialize);requireThat(JSON.stringify(await page.client.requestRaw('echo',{fresh:true}))===JSON.stringify({fresh:true}),'CLAIM_RPC_PROGRESS','independent page failed');
        await page.transport.close();fresh.close();if(remoteCount()===0&&lifetime==='last-claim')closes++;
      }else if(event.type==='heal'){
        // Explicit saved recovery action. Teardown never supplies these results.
        r.withheld.clear();r.releaseReplies();
        while(queue.length)await settle(queue[0]!,false);
        for(const wait of waits)if(wait.admitted&&!wait.nativeDone)await settle(wait,false);
        await open(0);await echo(channels[0]!);metrics.heals++;
      }
      await check();
    }
  }catch(error){failure=error;}
  try { if(f)await f.close(); } catch(error) {
    const detail=error instanceof Error?error.message:String(error);
    if(failure instanceof ChaosViolation)failure.cleanupFailure=detail;
    else if(!failure)failure=new ChaosViolation('CLAIM_CLEANUP',detail);
  }
  if(failure)throw failure;return metrics;
}
