import {nativeMessageFixture,messageAdapters,type MessageAdapter} from './native-message';
import {ChaosViolation,requireThat} from './recovery-chaos';
export const messageModes=['normal','throw','replace-a','add-b','renew'] as const;
export type MessageMode=typeof messageModes[number];
export type NativeMessageEvent={type:'open';adapter:MessageAdapter}|{type:'frame';mode:MessageMode}|{type:'rotate-a'|'remove-a'|'old-a'|'heal'};
export type NativeMessageMutant='drop-peer'|'stale-observation'|'orphan-heal';

export function parseNativeMessageTrace(value:unknown):NativeMessageEvent[]{
  requireThat(Array.isArray(value)&&value.length<=10000,'TRACE_SCHEMA','expected at most 10000 events');
  for(const event of value){
    requireThat(typeof event==='object'&&event!==null,'TRACE_SCHEMA','invalid event');
    const e=event as Record<string,unknown>;
    requireThat(['open','frame','rotate-a','remove-a','old-a','heal'].includes(String(e.type)),'TRACE_SCHEMA','unknown native message event');
    if(e.type==='open')requireThat(messageAdapters.includes(e.adapter as MessageAdapter),'TRACE_SCHEMA','invalid adapter');
    if(e.type==='frame')requireThat(messageModes.includes(e.mode as MessageMode),'TRACE_SCHEMA','invalid frame action');
  }
  return value as NativeMessageEvent[];
}
export function generateNativeMessageChaos(seed:number,steps:number):NativeMessageEvent[]{
  let state=seed>>>0;const next=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state>>>8;};
  const events:NativeMessageEvent[]=[{type:'open',adapter:messageAdapters[next()%messageAdapters.length]!}];
  for(let i=0;i<steps;i++){
    const choice=next()%10;
    if(choice<6)events.push({type:'frame',mode:messageModes[next()%messageModes.length]!});
    else events.push({type:(['rotate-a','remove-a','old-a','heal'] as const)[choice-6]!});
  }
  events.push({type:'heal'});return events;
}

/** The oracle evolves registration order and frame admission from saved input,
 * independently of which production callbacks actually run. A frame action is
 * explicitly compound: its first observer may throw, replace a peer or renew. */
export async function simulateNativeMessages(events:readonly NativeMessageEvent[],options:{mutant?:NativeMessageMutant}={}){
  let fixture:ReturnType<typeof nativeMessageFixture>|undefined,adapter:MessageAdapter|undefined;
  let expectedOrder:('a'|'b')[]=[],mode:MessageMode='normal',observed:string[]=[],renew:Promise<void>|undefined;
  let removeA=()=>{},removeB=()=>{},activeB=false;
  const oldA:(()=>void)[]=[],coverage:Record<string,number>={};
  const metrics={events:events.length,opens:0,frames:0,observations:0,renews:0,heals:0,coverage};
  const hit=(key:string)=>{coverage[key]=(coverage[key]??0)+1;};
  const callbackA=()=>{if(options.mutant!=='drop-peer')observed.push('a');};
  const callbackB=()=>{observed.push('b');};
  const rotateA=()=>{oldA.push(removeA);removeA();removeA=fixture!.transport.subscribeMessage(callbackA);};
  const addB=()=>{if(!activeB){activeB=true;removeB=fixture!.transport.subscribeMessage(callbackB);}};
  const close=async()=>{if(fixture){const current=fixture;fixture=undefined;await current.close();}};
  const open=async(kind:MessageAdapter)=>{
    await close();adapter=kind;fixture=nativeMessageFixture(kind);expectedOrder=['a'];activeB=false;oldA.length=0;
    fixture.transport.subscribeMessage(()=>{
      observed.push('actor');
      if(mode==='throw')throw Error('synthetic external message observer');
      if(mode==='replace-a')rotateA();
      if(mode==='add-b')addB();
      if(mode==='renew'){renew=fixture!.beginRenew();void renew.catch(()=>{});}
    });
    removeA=fixture.transport.subscribeMessage(callbackA);removeB=()=>{};
    await fixture.connect();metrics.opens++;requireThat(fixture.transport.status.state==='open','MESSAGE_CONNECT_SETTLEMENT','open intent did not establish native open');
  };
  const frame=async(action:MessageMode)=>{
    if(!fixture)return;
    mode=action;observed=[];renew=undefined;
    const admitted=[...expectedOrder];
    const expected=['actor',...(action==='renew'?[]:admitted.filter(id=>!(action==='replace-a'&&id==='a')))];
    // Update only from input. Callback execution never updates the oracle.
    if(action==='replace-a')expectedOrder=[...expectedOrder.filter(id=>id!=='a'),'a'];
    if(action==='add-b'&&!expectedOrder.includes('b'))expectedOrder.push('b');
    await fixture.publish(`frame-${metrics.frames++}`);hit(`mode.${action}`);
    if(options.mutant==='stale-observation'&&action==='renew')observed.push('a');
    requireThat(fixture.driverErrors.length===0,'MESSAGE_OBSERVER_ISOLATION','external observer escaped native delivery');
    if(action!=='renew')requireThat(fixture.transport.status.state==='open','MESSAGE_OBSERVER_ISOLATION','observation was classified as native failure');
    const rule=action==='renew'?'MESSAGE_CURRENT':action==='replace-a'||action==='add-b'?'MESSAGE_ADMISSION':'MESSAGE_DELIVERY';
    requireThat(JSON.stringify(observed)===JSON.stringify(expected),rule,`${adapter}/${action}: expected ${expected}, observed ${observed}`);
    metrics.observations+=observed.length;
    if(action==='renew'){
      requireThat(renew,'MESSAGE_CONNECT_SETTLEMENT','renew callback was not admitted');
      await fixture.finishRenew(renew);metrics.renews++;requireThat(fixture.transport.status.state==='open','MESSAGE_CONNECT_SETTLEMENT','successor did not become open');
    }
  };
  let failure:unknown;
  try{
    for(const event of events){
      hit(event.type);
      if(event.type==='open')await open(event.adapter);
      else if(event.type==='frame')await frame(event.mode);
      else if(event.type==='rotate-a'&&fixture){rotateA();expectedOrder=[...expectedOrder.filter(id=>id!=='a'),'a'];}
      else if(event.type==='remove-a'&&fixture){oldA.push(removeA);removeA();expectedOrder=expectedOrder.filter(id=>id!=='a');}
      else if(event.type==='old-a'&&fixture)oldA.at(-1)?.();
      else if(event.type==='heal'&&fixture&&adapter){
        await open(adapter);await frame('normal');metrics.heals++;
        requireThat(options.mutant!=='orphan-heal','MESSAGE_CONNECT_SETTLEMENT','control hides an otherwise completed heal result');
      }
    }
  }catch(error){failure=error;}
  try{removeB();await close();await renew?.catch(()=>{});}catch(error){
    const detail=error instanceof Error?error.message:String(error);
    if(failure instanceof ChaosViolation)failure.cleanupFailure=detail;else if(!failure)failure=new ChaosViolation('MESSAGE_CLEANUP',detail);
  }
  if(failure)throw failure;return metrics;
}
