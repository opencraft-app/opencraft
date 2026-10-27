import type { AppHostServer } from '@opencraft/app-host-server';
import { notificationFixture, flushCleanup, trackCleanup } from './host-notifications';
import { requireThat } from './recovery-chaos';
export type NotificationEvent = { type: 'setup'; lifetime: 'server'|'last-claim'; peer: boolean; notice: 'success'|'reject'|'throw'|'hold'; close: 'success'|'reject'|'hold' }
  | { type: 'open'|'retire'|'deadline'|'native-ok'|'native-fail'|'close-ok'|'repair-notify'|'admit'|'detach'|'probe'|'observe'|'heal'|'native-loss'|'recover' };
export type NotificationChaosMutant = 'wait-notice'|'duplicate-notice'|'admit-failed'|'block-native-recovery';
export function parseNotificationTrace(value: unknown): NotificationEvent[] {
  requireThat(Array.isArray(value)&&value.length<=10000,'TRACE_SCHEMA','expected at most 10000 notification events');
  for(const item of value){
    requireThat(typeof item==='object'&&item!==null,'TRACE_SCHEMA','invalid notification event');const e=item as Record<string,unknown>;
    requireThat(['setup','open','retire','deadline','native-ok','native-fail','close-ok','repair-notify','admit','detach','probe','observe','heal','native-loss','recover'].includes(String(e.type)),'TRACE_SCHEMA','invalid notification discriminant');
    if(e.type==='setup')requireThat(['server','last-claim'].includes(String(e.lifetime))&&typeof e.peer==='boolean'&&['success','reject','throw','hold'].includes(String(e.notice))&&['success','reject','hold'].includes(String(e.close)),'TRACE_SCHEMA','invalid notification composition');
  }return value as NotificationEvent[];
}
export function generateNotificationChaos(seed:number,steps:number):NotificationEvent[]{
  let state=seed>>>0;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state>>>8;};
  const events:NotificationEvent[]=[{type:'setup',lifetime:next()%2?'server':'last-claim',peer:next()%2===0,notice:(['success','reject','throw','hold'] as const)[next()%4]!,close:(['success','reject','hold'] as const)[next()%3]!},{type:'open'},{type:'probe'},{type:'retire'}];
  const setup=events[0] as Extract<NotificationEvent,{type:'setup'}>;
  if((setup.lifetime==='server'||setup.peer)&&setup.close==='success'){
    if(setup.notice==='hold')events.push({type:'deadline'});
    events.push({type:'native-loss'},{type:'recover'});
  }
  for(let i=0;i<steps;i++)events.push({type:(['deadline','native-ok','native-fail','close-ok','repair-notify','admit','detach','probe','observe','heal','native-loss','recover'] as const)[next()%12]!});
  events.push({type:'heal'});return events;
}
/** One saved retirement transaction plus explicit recovery. The input-owned
 * ledger predicts notification attempts, local deadlines, admission fences and
 * physical release independently of the Server's status or private fields. */
export async function simulateHostNotifications(events:readonly NotificationEvent[],options:{Server?:typeof AppHostServer;mutant?:NotificationChaosMutant}={}){
  type Fixture=ReturnType<typeof notificationFixture>;type Page=ReturnType<Fixture['page']>;type Channel=ReturnType<Page['channel']>;
  type PhysicalPhase='open'|'closing'|'failed'|'closed';
  let f:Fixture|undefined,setup:Extract<NotificationEvent,{type:'setup'}>|undefined,page:Page|undefined,primary:Channel|undefined,peer:Channel|undefined,healed:Channel|undefined;
  let closing:ReturnType<typeof trackCleanup>|undefined,opened=false,retired=false,detached=false,healing=false,nativeOpen=true;
  let phase:PhysicalPhase='open',notice:'pending'|'success'|'failure'='pending',noticeDone=false,localCode:string|undefined,fenced=false;
  let primaryDone=false,primaryCode:string|undefined,replacement=false;
  let recovery:{page:Page;track:ReturnType<typeof trackCleanup>;expected:'pending'|'resolved'|'rejected';code?:string;counted:boolean}|undefined;
  let notifyMode:'success'|'reject'|'throw'|'hold'='success',attempts=0,closeCalls=0,factories=0,resources=0,admissions=0;
  const coverage:Record<string,number>={},metrics={events:events.length,connectIntents:0,connectSettled:0,cleanupCalls:0,nativeAdmissions:0,rpcIntents:0,rpcFrames:0};
  const cover=(k:string)=>{coverage[k]=(coverage[k]??0)+1;};
  const inNotice=(value:'pending'|'success'|'failure')=>notice===value;
  const eligible=()=>setup?.lifetime==='last-claim'&&!setup.peer;
  const responseReady=()=>retired&&noticeDone&&(!eligible()||phase!=='closing');
  const failCode=()=>eligible()&&phase==='failed'?'APP_HOST_CLEANUP_FAILED':localCode;
  const nativeResult=(success:boolean)=>{
    notice=success?'success':'failure';
    if(phase!=='closed')fenced=!success;
    if(!noticeDone){noticeDone=true;localCode=success?undefined:'APP_HOST_FAILURE';}
  };
  const check=()=>{
    if(!f||!opened)return;const p=f.physicals[0]!;
    const seenCalls=p.notifications.length+(options.mutant==='duplicate-notice'&&p.notifications.length?1:0);
    requireThat(seenCalls===attempts,'NOTIFY_EXACT_ONCE',`native notifications ${seenCalls}, expected ${attempts}`);
    const seenClose=options.mutant==='wait-notice'&&closeCalls>0?0:p.closeCalls;
    requireThat(seenClose===closeCalls,'NOTIFY_CLOSE_PROGRESS',`physical closes ${seenClose}, expected ${closeCalls}`);
    requireThat(f.physicals.length===factories,'NOTIFY_FACTORY_OWNERSHIP','unexpected replacement factory');
    requireThat(f.physicals.filter(p=>!p.released).length===resources&&resources<=1,'NOTIFY_PHYSICAL_CONSERVATION','resource release differs from saved close outcome');
    if(closing){const expected=detached||primaryDone?'resolved':'pending';requireThat(closing.state===expected,'NOTIFY_LOCAL_PROGRESS',`local close ${closing.state}, expected ${expected}`);}
    if(!detached&&primaryDone){
      const request=page!.wire.find(m=>m.type==='host/disconnect');
      const response=page!.replies.find(m=>m.type==='response'&&m.requestId===request?.requestId);
      requireThat(response?.type==='response','NOTIFY_CONTROL_OUTCOME','missing own disconnect response');
      requireThat(response.ok?!primaryCode:response.error.code===primaryCode,'NOTIFY_CONTROL_OUTCOME','wrong notification/physical outcome classification');
    }
  };
  const probe=async(c:Channel)=>{
    const token=++metrics.rpcIntents;let value:unknown;const pending=trackCleanup(c.client.requestRaw('echo',{token}).then(result=>{value=result;}));await flushCleanup();
    requireThat(pending.state==='resolved'&&JSON.stringify(value)===JSON.stringify({token}),'NOTIFY_PEER_PROGRESS','live peer or explicit heal failed actual echo');await pending.promise;metrics.rpcFrames++;
  };
  const predictPrimary=()=>{if(!primaryDone&&responseReady()){primaryDone=true;primaryCode=failCode();}};
  const startRecovery=()=>{
    if(recovery)return;
    const next=f!.page();metrics.connectIntents++;
    recovery={page:next,track:trackCleanup(next.bridge.connectHost('a','native-recovery')),expected:'pending',counted:false};
    closeCalls++;cover('native.recovery-attempt');
    if(setup!.close==='success'){phase='closed';resources=0;fenced=false;noticeDone=true;recovery.expected='resolved';}
    else if(setup!.close==='reject'){phase='failed';if(!noticeDone){noticeDone=true;localCode='APP_HOST_CLEANUP_FAILED';}recovery.expected='rejected';recovery.code='APP_HOST_CLEANUP_FAILED';}
    else phase='closing';
  };
  const settleRecovery=async()=>{
    if(!recovery)return;
    const observed=options.mutant==='block-native-recovery'?'rejected':recovery.track.state;
    requireThat(observed===recovery.expected,'NOTIFY_NATIVE_RECOVERY',`native recovery ${observed}, expected ${recovery.expected}`);
    if(recovery.expected==='rejected')requireThat((recovery.track.error as {code?:string}).code===recovery.code,'NOTIFY_NATIVE_RECOVERY','native recovery returned the wrong manual outcome');
    if(recovery.counted||recovery.expected==='pending')return;
    recovery.counted=true;metrics.connectSettled++;
    if(recovery.expected==='resolved'){
      if(!replacement){factories++;resources++;replacement=true;}
      nativeOpen=true;healing=true;healed=recovery.page.channel();metrics.connectIntents++;
      await healed.open();metrics.connectSettled++;cover('native.actual-recovery');await probe(healed);
    }
  };
  try{
    for(const event of events){cover(event.type);
      if(event.type==='setup'){
        if(f)continue;setup=event;notifyMode=event.notice;
        f=notificationFixture({Server:options.Server,lifetime:event.lifetime,onCreate(p,i){if(!i){p.notifyMode=event.notice;p.mode=event.close;}}});page=f.page();continue;
      }
      if(!f||!setup||!page)continue;
      if(event.type==='open'){
        if(opened)continue;primary=page.channel();metrics.connectIntents++;await primary.open();metrics.connectSettled++;
        if(setup.peer){peer=f.page().channel();metrics.connectIntents++;await peer.open();metrics.connectSettled++;}
        opened=true;factories=resources=1;await probe(primary);
      }else if(event.type==='retire'){
        if(!opened||retired||healing)continue;retired=true;attempts++;closing=trackCleanup(primary!.client.close());
        if(notifyMode!=='hold')nativeResult(notifyMode==='success');
        if(eligible()){
          cover('retire.last-claim');closeCalls++;
          if(setup.close==='hold')phase='closing';
          else if(setup.close==='reject'){phase='failed';noticeDone=true;}
          else{phase='closed';resources=0;fenced=false;noticeDone=true;}
        }
      }else if(event.type==='deadline'){
        if(!retired||healing)continue;
        if(!noticeDone){cover('deadline.pending');noticeDone=true;localCode='APP_HOST_DISCONNECT_TIMEOUT';fenced=true;}
        if(recovery?.expected==='pending'){recovery.expected='rejected';recovery.code='APP_HOST_CLEANUP_TIMEOUT';}
        await f.deadline();
      }else if(event.type==='native-ok'||event.type==='native-fail'){
        if(!retired||healing||!inNotice('pending'))continue;
        if(noticeDone)cover('native.late-result');
        const n=f.physicals[0]!.notifications.at(-1)!;
        event.type==='native-ok'?n.gate.resolve():n.gate.reject(Error('saved native notification rejection'));
        nativeResult(event.type==='native-ok');
      }else if(event.type==='close-ok'){
        if(phase!=='closing'||healing)continue;
        cover('close.actual-release');f.physicals[0]!.closeGate.resolve();phase='closed';resources=0;fenced=false;noticeDone=true;
        if(recovery?.expected==='pending')recovery.expected='resolved';
      }else if(event.type==='repair-notify'){
        notifyMode='success';if(opened)f.physicals[0]!.notifyMode='success';
      }else if(event.type==='admit'){
        if(!retired||healing||phase==='closing')continue;
        if(phase==='open'&&!nativeOpen){startRecovery();predictPrimary();await flushCleanup();await settleRecovery();check();continue;}
        if(phase!=='failed'&&!fenced)continue;
        cover('admit.fenced');let code:string|undefined;try{await f.page().bridge.connectHost('a',`admission-${++admissions}`);}catch(e){code=(e as {code?:string}).code;}
        if(options.mutant==='admit-failed')code=undefined;
        requireThat(code===(phase==='failed'?'APP_HOST_CLEANUP_FAILED':'APP_HOST_LOGICAL_CLEANUP_FAILED'),'NOTIFY_ADMISSION_FENCE','failed cleanup allowed a new registration');
      }else if(event.type==='detach'){
        if(!retired||detached||healing)continue;
        // A known failed write may be retried once by this explicit close.
        if(phase==='open'&&inNotice('failure')){
          cover('detach.retry-known');attempts++;notice='pending';
          if(notifyMode!=='hold')nativeResult(notifyMode==='success');
        }
        if(inNotice('pending'))cover('detach.join-unknown');
        detached=true;try{page.connection.close();}catch{requireThat(false,'NOTIFY_DETACH_PROGRESS','provider throw escaped logical detach');}page.bridge.close();
      }else if(event.type==='probe'){
        if(healed)await probe(healed);else if(peer&&nativeOpen)await probe(peer);
      }else if(event.type==='native-loss'){
        if(!retired||healing||phase!=='open'||!nativeOpen)continue;
        nativeOpen=false;cover('native.actual-loss');f.physicals[0]!.publish({state:'closed'});
      }else if(event.type==='recover'){
        if(!retired||healing||phase!=='open'||nativeOpen)continue;
        startRecovery();
      }else if(event.type==='heal'){
        if(!opened||!retired||healing)continue;healing=true;cover('heal.actual');const p=f.physicals[0]!;
        p.notifyMode='success';p.mode='success';
        if(inNotice('pending')){p.releaseNotifications();nativeResult(true);}
        if(phase==='closing'){p.closeGate.resolve();phase='closed';resources=0;fenced=false;noticeDone=true;if(recovery?.expected==='pending')recovery.expected='resolved';}
        predictPrimary();await flushCleanup();await settleRecovery();if(healed){check();continue;}
        if(phase==='failed'){cover('heal.reset-failed');closeCalls++;await f.server.resetHost('a');phase='closed';resources=0;fenced=false;noticeDone=true;}
        if(!detached){
          if(phase==='open'&&inNotice('failure')){attempts++;nativeResult(true);}
          page.connection.close();page.bridge.close();detached=true;
        }
        await flushCleanup();
        // A detached failed retry remains owned until an explicit reset.
        if(fenced&&phase==='open'){closeCalls++;await f.server.resetHost('a');phase='closed';resources=0;fenced=false;}
        if(phase==='open'&&!nativeOpen){closeCalls++;phase='closed';resources=0;fenced=false;noticeDone=true;}
        healed=f.page().channel();metrics.connectIntents++;await healed.open();metrics.connectSettled++;
        if(phase==='closed'&&!replacement){factories++;resources++;replacement=true;}
        await probe(healed);
      }
      predictPrimary();await flushCleanup();await settleRecovery();check();
    }
    metrics.cleanupCalls=closeCalls;metrics.nativeAdmissions=attempts;return {...metrics,coverage};
  }finally{await f?.close();}
}
