import type { ChannelMember, ChannelSummary, CrewTeam, PersonalAssistantStatus } from '@opencraft/appserver-protocol';
import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { ChannelsClient, type ChannelRpc } from './channel-client';
import { ImHttpError } from './client';
import { inboxGroups } from './people-directory';
import { resolveAssistantPresetId } from './assistant-actors';

export type ChannelReadState<T>={value?:T;failed:boolean;authoritative:boolean;error?:unknown};
export interface ChannelRead<T>{get():ChannelReadState<T>;subscribe(fn:()=>void):()=>void;refresh(signal?:AbortSignal):Promise<void>;set(value:T):void;hold():()=>void;invalidate():void;fail(error:unknown):void;clear():void;readonly observed:boolean}
const denied=(error:unknown)=>error instanceof ImHttpError&&[401,403].includes(error.status)||error instanceof Error&&error.message==='channel_denied';
/** A replica owns cancellation and publication, rather than a mounted View. */
export function createChannelRead<T>(scope:AbortSignal,read:(signal:AbortSignal)=>Promise<T>):ChannelRead<T>{
  let state:ChannelReadState<T>={failed:false,authoritative:false},retired=false,held=0,owner:AbortController|undefined,flight:Promise<void>|undefined;
  const listeners=new Set<()=>void>();
  const publish=(next:typeof state)=>{state=next;for(const fn of [...listeners])fn();};
  const cancel=()=>{owner?.abort();owner=undefined;flight=undefined;};
  const resource:ChannelRead<T>={get:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},get observed(){return listeners.size>0},
    refresh(signal){
      if(retired||scope.aborted||held)return Promise.resolve();if(flight)return flight;
      const current=new AbortController();owner=current;
      const request=combineAbortSignals([scope,current.signal,...(signal?[signal]:[]),AbortSignal.timeout(10000)]);
      const pending=read(request.signal).then(value=>{if(owner===current&&!request.signal.aborted&&!retired)publish({value,failed:false,authoritative:true});},error=>{
        if(owner!==current||scope.aborted||current.signal.aborted||signal?.aborted||retired)return;
        publish(denied(error)?{failed:true,authoritative:false,error}:{...state,failed:true,authoritative:false,error});
      }).finally(()=>{request.dispose();if(owner===current){owner=undefined;flight=undefined;}});
      return flight=pending;
    },
    set(value){if(retired||scope.aborted)return;cancel();publish({value,failed:false,authoritative:true});},
    hold(){cancel();held++;let active=true;return()=>{if(active){active=false;held--;}};},
    invalidate(){if(retired)return;cancel();publish({...state,failed:false,error:undefined,authoritative:false});},
    fail(error){if(retired||scope.aborted)return;cancel();publish(denied(error)?{failed:true,authoritative:false}:{...state,failed:true,authoritative:false});},
    clear(){retired=true;cancel();publish({failed:true,authoritative:false});}
  };
  scope.addEventListener('abort',()=>resource.clear(),{once:true});if(scope.aborted)resource.clear();return resource;
}
export type ChannelDirectory={groups:ChannelSummary[];all:ChannelSummary[];members:Record<string,ChannelMember[]>};
const runtimes=new WeakMap<ChannelRpc,ChannelRuntime>();
const EMPTY_DEFAULT_ASSISTANT:PersonalAssistantStatus={assistant:null,channelId:null,runtime:{phase:'stopped'}};

/** One authenticated extension owns directory, unified AssistantActor, and Crew team replicas. */
export function getChannelRuntime(fetcher:typeof fetch,transport:ChannelRpc,activation:AbortSignal){
  const resident=runtimes.get(transport);if(resident)return resident;
  const scope=new AbortController(),identity=transport.draftScope,scopeListeners=new Set<()=>void>();
  const assertScope=()=>{if(transport.draftScope!==identity)scope.abort(Error('Channel identity changed'));scope.signal.throwIfAborted();};
  const rpc:ChannelRpc={
    get draftScope(){return identity},get supportsGroupLifecycle(){return transport.supportsGroupLifecycle},get supportsRead(){return transport.supportsRead},get supportsAttachments(){return transport.supportsAttachments},get supportsAttachmentChunks(){return transport.supportsAttachmentChunks},
    async connect(){assertScope();await transport.connect();assertScope();},
    async request(method,params,signal,options){assertScope();const request=combineAbortSignals([scope.signal,...(signal?[signal]:[])]);try{const value=await transport.request(method,params,request.signal,options);assertScope();request.signal.throwIfAborted();return value;}catch(error){if(error instanceof Error&&(error.message==='actor_authentication_required'||(error as {status?:number}).status===401))scope.abort(error);throw error;}finally{request.dispose();}},
    onChanged:fn=>transport.onChanged(fn),onDisconnect:fn=>transport.onDisconnect(fn),onRecoveryHint:fn=>transport.onRecoveryHint?.(fn)??(()=>{}),close:()=>transport.close()
  };
  const client=new ChannelsClient(fetcher,rpc);
  const directory=createChannelRead(scope.signal,async signal=>{
    const {groups:all}=await client.list(signal),groups=inboxGroups(all);
    const members=await Promise.all(groups.slice(0,12).map(async group=>{
      try{return[group.id,(await client.members(group.id,signal)).members.slice(0,9)] as const;}catch(error){signal.throwIfAborted();return[group.id,[] as ChannelMember[]] as const;}
    }));signal.throwIfAborted();return{all,groups,members:Object.fromEntries(members)};
  });
  const assistants=createChannelRead<PersonalAssistantStatus[]>(scope.signal,async signal=>{
    await rpc.connect();
    const listed=await rpc.request('opencraft/personal-assistant/bots/list',{},signal);
    if(listed&&Array.isArray(listed.bots)){
      return listed.bots.filter(row=>Boolean(row?.assistant));
    }
    const single=await client.assistantStatus(signal);
    return single?.assistant?[single]:[];
  });
  // `null` indicates this Host does not expose Crew team spaces; `CrewTeam[]` means Crew is active.
  const teams:ChannelRead<CrewTeam[]|null>=createChannelRead<CrewTeam[]|null>(scope.signal,async(signal):Promise<CrewTeam[]|null>=>{
    await rpc.connect();
    try{
      const result=await rpc.request('opencraft/crew/teams',{},signal);
      return result&&Array.isArray(result.teams)?result.teams:null;
    }catch(error){
      if(denied(error))throw error;
      signal.throwIfAborted();
      const prior=teams.get().value;
      return prior!==undefined?prior:null;
    }
  });
  // Projected compatibility views derived from the single authoritative `assistants` replica.
  const assistant=createChannelRead<PersonalAssistantStatus>(scope.signal,async signal=>{
    await assistants.refresh(signal);
    const current=assistants.get();
    if(current.failed&&!current.value)throw current.error??Error('assistant_unavailable');
    return current.value?.find(r=>r.assistant&&resolveAssistantPresetId(r.assistant)==='personal-assistant')??EMPTY_DEFAULT_ASSISTANT;
  });
  const bots=createChannelRead<PersonalAssistantStatus[]>(scope.signal,async signal=>{
    await assistants.refresh(signal);
    const current=assistants.get();
    if(current.failed&&!current.value)throw current.error??Error('assistant_unavailable');
    return (current.value??[]).filter(r=>r.assistant&&resolveAssistantPresetId(r.assistant)!=='personal-assistant');
  });
  assistants.subscribe(()=>{
    const current=assistants.get();
    if(current.value!==undefined&&current.authoritative&&!current.failed){
      assistant.set(current.value.find(r=>r.assistant&&resolveAssistantPresetId(r.assistant)==='personal-assistant')??EMPTY_DEFAULT_ASSISTANT);
      bots.set(current.value.filter(r=>r.assistant&&resolveAssistantPresetId(r.assistant)!=='personal-assistant'));
    }else if(current.failed){
      assistant.fail(current.error);
      bots.fail(current.error);
    }else if(!current.authoritative){
      assistant.invalidate();
      bots.invalidate();
    }
  });
  const runtime={rpc,client,directory,assistants,teams,assistant,bots,identity,signal:scope.signal,subscribeScope:(fn:()=>void)=>{scopeListeners.add(fn);return()=>{scopeListeners.delete(fn)}},getScope:()=>!scope.signal.aborted};
  runtimes.set(transport,runtime);
  const detachIdentity=transport.onDisconnect(()=>{if(transport.draftScope!==identity)scope.abort(Error('Channel identity changed'));});
  const abort=()=>scope.abort(activation.reason);activation.addEventListener('abort',abort,{once:true});
  const poll=setInterval(()=>{if(assistants.observed||assistant.observed||bots.observed)void assistants.refresh();},2500);
  const teamPoll=setInterval(()=>{if(teams.observed&&teams.get().value!==null)void teams.refresh();},15000);
  scope.signal.addEventListener('abort',()=>{clearInterval(poll);clearInterval(teamPoll);void transport.close().catch(()=>{});detachIdentity();activation.removeEventListener('abort',abort);for(const fn of [...scopeListeners])fn();},{once:true});
  client.watch(undefined,async signal=>{await directory.refresh(signal);if(signal.aborted)return;if(directory.get().failed)throw directory.get().error;void assistants.refresh(signal);void teams.refresh(signal);},error=>{if(denied(error))scope.abort(error);else{directory.fail(error);assistants.fail(error);}},scope.signal,{onInvalidate:()=>{void assistants.refresh();void teams.refresh();},onConnectionLost:()=>{directory.invalidate();assistants.invalidate();teams.invalidate();}});
  if(activation.aborted)abort();return runtime;
}
export type ChannelRuntime={readonly rpc:ChannelRpc;readonly client:ChannelsClient;readonly directory:ChannelRead<ChannelDirectory>;readonly assistants:ChannelRead<PersonalAssistantStatus[]>;readonly teams:ChannelRead<CrewTeam[]|null>;readonly assistant:ChannelRead<PersonalAssistantStatus>;readonly bots:ChannelRead<PersonalAssistantStatus[]>;readonly identity:string|undefined;readonly signal:AbortSignal;subscribeScope(fn:()=>void):()=>void;getScope():boolean};
