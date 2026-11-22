import { PeopleDefaultFaceArtwork as DefaultFace, PeopleEntryGlyph as EntryGlyph } from "@opencraft/design-system-web/action-icons";
import {ManagedBots} from './managed-bots';
import { CrewTeams } from './crew-teams';
// Crew work and the desk load when the Work tab is first opened, not with the Inbox.
const CrewWorkList=lazy(()=>import('./crew-work-view').then(m=>({default:m.CrewWorkList})));
import { getChannelRuntime, type ChannelRuntime, type ChannelRead, type ChannelReadState } from './channel-runtime';
import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { AssistantMemory } from './assistant-memory';
import { AssistantThreadSettings } from './assistant-thread-settings';
import { PeopleIcon, AgentIcon, SettingsGearIcon } from '@opencraft/design-system-web/action-icons';
import { lazy, Suspense, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChannelPerson, PersonalAssistantStatus, PersonalAssistantModelCatalog } from '@opencraft/appserver-protocol';
import { CompanionAvatar } from '@opencraft/design-system-web/companion-avatar';
import { ObjectRowButton } from '@opencraft/design-system-web/button';
import { NavigationList, NavigationItem } from '@opencraft/design-system-web/navigation';
import { AvatarImage, StandardPage, StandardPageTitle, IdentityAvatarContext, SettingsButton, SettingsIconButton, SegmentedControl, SettingsChoiceSelect, SettingsSection, SettingsGroup, SettingsRow, SettingsTextInput, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';
import type { ChannelRpc } from './channel-client';
import { CreateGroupButton } from './channel-group-controls';
import { parseChannelResource } from './channel-search';
import './people.scss';

export const PEOPLE_VIEW_ID='opencraft.im.people';
export const AGENTS_VIEW_ID='opencraft.im.agents';
const agentsTitle={id:'agents.title',defaultMessage:'Assistants'};
const title={id:'people.title',defaultMessage:'Inbox'};
const messages={
  memory:{id:'people.memory.title',defaultMessage:'Memory'},
  agentsAbout:{id:'agents.about',defaultMessage:'Hire an assistant to handle everyday work with you. Each assistant keeps its own private memory.'},
  myAgents:{id:'agents.mine',defaultMessage:'My assistants'},
  available:{id:'agents.available',defaultMessage:'Available to hire'},
  hire:{id:'agents.hire',defaultMessage:'Hire'},
  personal:{id:'agents.personal',defaultMessage:'Personal assistant'},
  personalAbout:{id:'agents.personalAbout',defaultMessage:'Manages tasks, remembers your preferences and reads the group chats and conversations you can access. The assistant and its memory belong only to you.'},
  groups:{id:'people.groups',defaultMessage:'Group chats'},
  recent:{id:'people.recent',defaultMessage:'Recent group chats'},
  noGroups:{id:'people.noGroups',defaultMessage:'No recent group messages.'},
  manage:{id:'people.manage',defaultMessage:'Assistant settings'},
  closeDetails:{id:'people.closeDetails',defaultMessage:'Close assistant settings'},
  searchAll:{id:'people.searchAll',defaultMessage:'Search groups, people and assistants'},
  image:{id:'people.image',defaultMessage:'[Image]'},
  ready:{id:'people.ready',defaultMessage:'Open to start a conversation'},
  model:{id:'people.model',defaultMessage:'Model'},
  chooseModel:{id:'people.chooseModel',defaultMessage:'Choose a model'},
  modelAbout:{id:'people.modelAbout',defaultMessage:'New requests use this model. Tasks already in progress are not affected.'},
  noModels:{id:'people.noModels',defaultMessage:'No model is available yet. Ask your administrator to set one up.'},
  modelServiceUnavailable:{id:'people.modelServiceUnavailable',defaultMessage:'Models could not be read right now. Close and reopen settings to try again.'},
  modelUnavailable:{id:'people.modelUnavailable',defaultMessage:'Selected model is unavailable'},
  modelFailed:{id:'people.modelFailed',defaultMessage:'The model was not saved. Choose it again.'},
  members:{id:'people.members',defaultMessage:'Members'},
  assistant:{id:'people.assistant',defaultMessage:'My assistant'},
  reclaim:{id:'people.reclaim',defaultMessage:'Resume assistant'},
  stopped:{id:'people.stopped',defaultMessage:'Paused. The assistant and its memory are kept.'},
  config_required:{id:'people.configRequired',defaultMessage:'Choose a model and the assistant can start working.'},
  unavailable:{id:'people.unavailable',defaultMessage:'The assistant can’t run right now. Its data is kept.'},
  starting:{id:'people.starting',defaultMessage:'Starting…'},
  queued:{id:'people.queued',defaultMessage:'Waiting to start…'},
  running:{id:'people.running',defaultMessage:'Ready. Keeps working after you close this page.'},
  retrying:{id:'people.retrying',defaultMessage:'Couldn’t start. Retrying automatically…'},
  open:{id:'people.open',defaultMessage:'Open chat'},
  stop:{id:'people.stop',defaultMessage:'Pause assistant'},
  stopConfirm:{id:'people.stopConfirm',defaultMessage:'The assistant will stop taking new messages. Its memory and conversations are kept, and you can resume it at any time.'},
  stopConfirmAction:{id:'people.stopConfirmAction',defaultMessage:'Pause'},
  cancel:{id:'people.cancel',defaultMessage:'Cancel'},
  retry:{id:'people.retry',defaultMessage:'Retry'},
  loading:{id:'people.loading',defaultMessage:'Loading…'},
  failed:{id:'people.failed',defaultMessage:'Can’t connect right now. Retrying…'},
  actionFailed:{id:'people.actionFailed',defaultMessage:'That didn’t go through. Try again.'},
  listFailed:{id:'people.listFailed',defaultMessage:'Members could not be loaded.'},
  search:{id:'people.search',defaultMessage:'Search people and assistants'},
  human:{id:'people.human',defaultMessage:'Person'},
  bot:{id:'people.bot',defaultMessage:'Assistant'},
  chat:{id:'people.chat',defaultMessage:'Message'},
  more:{id:'people.more',defaultMessage:'Load more'},
  empty:{id:'people.empty',defaultMessage:'No matching members.'},
};
/** Shown when no external avatar resolves: a stable tinted tile with a person silhouette. */
function Avatar({person}:{person:Pick<ChannelPerson,'actorId'|'kind'|'displayName'|'avatar'>}) {
  const avatars = useContext(IdentityAvatarContext);
  return person.kind==='bot'?<CompanionAvatar id={person.actorId} />:
    <span className="people-human-avatar" aria-hidden="true"><AvatarImage
      src={person.avatar ? avatars?.resolve(person.avatar.kind, person.avatar.name) ?? null : null} fallback={<DefaultFace seed={person.displayName}/>}
    /></span>;
}

function useResource<T>(resource:ChannelRead<T>,interval:number):ChannelReadState<T> {
  const state=useSyncExternalStore(resource.subscribe,resource.get,resource.get);
  useEffect(()=>{
    if(!interval)return;void resource.refresh();
    const poll=setInterval(()=>{if(document.visibilityState!=='hidden')void resource.refresh();},interval);
    return()=>clearInterval(poll);
  },[resource,interval]);
  return state;
}
function useDebounced<T>(value:T,delay:number):T {
  const [settled,setSettled]=useState(value);
  useEffect(()=>{const timer=setTimeout(()=>setSettled(value),delay);return()=>clearTimeout(timer);},[value,delay]);
  return settled;
}
/** Shape-preserving placeholders. CSS keeps them invisible for a short grace
 * period, so a warm or fast read never flashes a loading frame. */
function SkeletonLine({width}:{width:string}) {return <span className="people-skeleton people-skeleton-line" style={{inlineSize:width}} aria-hidden="true"/>;}
function SkeletonRows({count,variant}:{count:number;variant:'group'|'member'|'card'}) {
  return <div className={'people-skeleton-rows people-skeleton-rows--'+variant} aria-hidden="true">{Array.from({length:count},(_,i)=><div className="people-skeleton-row" key={i}>
    <span className="people-skeleton people-skeleton-avatar"/>
    <span className="people-skeleton-copy"><SkeletonLine width={['9em','12em','7em','10em'][i%4]!}/>{variant==='member'?null:<SkeletonLine width={['16em','11em','14em'][i%3]!}/>}</span>
  </div>)}</div>;
}

/** One directory replica per authenticated extension lifetime. No claim on mount/login. */
export function createPeopleViews(transport:ChannelRpc, activation:AbortSignal, chatViewId:string, runtime:ChannelRuntime=getChannelRuntime(fetch,transport,activation)) {
  const {rpc,signal}=runtime;
  let snapshot:{people:ChannelPerson[];loaded:boolean;failed:boolean}={people:[],loaded:false,failed:false};
  const listeners=new Set<()=>void>();let refreshing:Promise<void>|undefined;
  const getSnapshot=()=>snapshot;
  const emit=()=>listeners.forEach(fn=>fn());
  async function refresh() {
    if(refreshing||signal.aborted)return refreshing;
    return refreshing=(async()=>{
      try {await rpc.connect();const result=await rpc.request('opencraft/channels/people/list',{},signal);
        if(!signal.aborted){snapshot={people:result.people,loaded:true,failed:false};emit();}
      } catch {if(!signal.aborted){snapshot={...snapshot,failed:true};emit();}}
    })().finally(()=>{refreshing=undefined;});
  }
  const timer=setInterval(()=>{if(listeners.size)void refresh();},30000);
  const retirePeople=()=>{clearInterval(timer);snapshot={people:[],loaded:false,failed:true};emit();listeners.clear();};signal.addEventListener('abort',retirePeople,{once:true});if(signal.aborted)retirePeople();
  const subscribe=(fn:()=>void)=>{listeners.add(fn);void refresh();return()=>{listeners.delete(fn);};};
  const groupsResource=runtime.directory,statusResource=runtime.assistant;
  function Entry({host}:ExtensionSettingsViewProps) {
    const intl=useIntl(),state=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
    return <NavigationList label={intl.formatMessage(title)} inset="contained"><NavigationItem
      aria-current={[PEOPLE_VIEW_ID,chatViewId].includes(host.activeView?.viewId??'')?'page':undefined} onClick={()=>host.openView(PEOPLE_VIEW_ID)}>
      <EntryGlyph kind="inbox"/><span data-navigation-label="" className="people-entry-label">{intl.formatMessage(title)}</span>
    </NavigationItem><NavigationItem aria-current={host.activeView?.viewId===AGENTS_VIEW_ID?'page':undefined} onClick={()=>host.openView(AGENTS_VIEW_ID)}>
      <EntryGlyph kind="assistant"/><span data-navigation-label="" className="people-entry-label">{intl.formatMessage(agentsTitle)}</span>
    </NavigationItem></NavigationList>;
  }
  function DirectoryPage({host,reportError,regions,mode}:ExtensionSettingsViewProps & {mode:'inbox'|'agents'}) {
    const intl=useIntl(),f=(key:keyof typeof messages)=>intl.formatMessage(messages[key]);
    const [openingPerson,setOpeningPerson]=useState<string|null>(null);
    async function openDirect(actorId:string){
      if(openingPerson)return;setOpeningPerson(actorId);
      try{await rpc.connect();const channel=await rpc.request('opencraft/channels/direct/open',{actorId},signal);if(!signal.aborted)host.openView(chatViewId,'opencraft-channel:'+channel.id);}
      catch{if(!signal.aborted)reportError?.({key:'people-direct',message:intl.formatMessage({id:'people.directFailed',defaultMessage:'Could not open this conversation.'})});}
      finally{if(!signal.aborted)setOpeningPerson(null);}
    }
    const [tab,setTab]=useState('groups'),[details,setDetails]=useState(false),[confirmStop,setConfirmStop]=useState(false),[listRetry,setListRetry]=useState(0);
    const groupsState=useResource(groupsResource,0),statusState=useResource(statusResource,0);
    const groups=groupsState.value?.groups??[],groupMembers=groupsState.value?.members??{};
    const groupsPending=!groupsState.value&&!groupsState.failed,groupsFailed=!groupsState.value&&groupsState.failed;
    const [memoryOpen,setMemoryOpen]=useState(false);
    const memoryCloseGuard=useRef<(()=>boolean)|null>(null);
    const [activeAction,setActiveAction]=useState<string|null>(null);
    const status=statusState.value??null,failed=!status&&statusState.failed,[pending,setPending]=useState(false);
    const setStatus=(value:PersonalAssistantStatus)=>statusResource.set(value);
    const [catalog,setCatalog]=useState<PersonalAssistantModelCatalog|null>(null),[modelsLoading,setModelsLoading]=useState(false),[modelSaving,setModelSaving]=useState(false);
    const modelEpoch=useRef(0),modelBusy=useRef(false);
    const busy=useRef(false),lifetime=useRef<AbortController|null>(null);
    const [query,setQuery]=useState(''),search=useDebounced(query.trim(),200);
    const [people,setPeople]=useState<ChannelPerson[]>(()=>snapshot.people),[next,setNext]=useState<string|null>(null),[listing,setListing]=useState(!snapshot.loaded),[listFailed,setListFailed]=useState(false);
    const listEpoch=useRef(0);
    const warn=()=>reportError?.({key:'personal-assistant',message:f('actionFailed')});
    useEffect(()=>{
      const controller=new AbortController();lifetime.current=controller;
      const retire=()=>controller.abort();signal.addEventListener('abort',retire,{once:true});if(signal.aborted)retire();
      return()=>{signal.removeEventListener('abort',retire);controller.abort();lifetime.current=null;};
    },[]);
    useEffect(()=>{
      if(mode==='agents')return;
      const controller=new AbortController(),epoch=++listEpoch.current;
      const request=combineAbortSignals([signal,controller.signal]);
      // Keep the previous rows until the replacement arrives; no blank frame per keystroke.
      setListing(true);setListFailed(false);
      void rpc.connect().then(()=>rpc.request('opencraft/channels/people/list',search?{query:search}:{},request.signal)).then(result=>{
        if(!controller.signal.aborted&&epoch===listEpoch.current){setPeople(result.people);setNext(result.next);}
      }).catch(()=>{if(!controller.signal.aborted)setListFailed(true);}).finally(()=>{if(!controller.signal.aborted)setListing(false);});
      return()=>{controller.abort();request.dispose();};
    },[search,status?.assistant?.state,listRetry]);
    async function action(op:'claim'|'revoke'|'retry'|'open') {
      const current=lifetime.current;if(!current||signal.aborted||!statusResource.get().authoritative||busy.current||modelBusy.current)return;busy.current=true;const release=statusResource.hold();setPending(true);setActiveAction(op);
      try {
        await rpc.connect();
        if(op==='open'){const result=await rpc.request('opencraft/personal-assistant/open',{},current.signal);if(!current.signal.aborted)host.openView(chatViewId,'opencraft-channel:'+result.channel.id);}
        else {const result=await rpc.request(`opencraft/personal-assistant/${op}`,{},current.signal);if(!current.signal.aborted){setStatus(result);void refresh();}}
      }catch{if(!current.signal.aborted)warn();}finally{busy.current=false;release();if(!current.signal.aborted){setPending(false);setActiveAction(null);}}
    }
    const assistant=status?.assistant,claimed=assistant?.state==='claimed';
    async function loadModels() {
      const current=lifetime.current;if(!current)return;
      const epoch=++modelEpoch.current;setModelsLoading(true);
      try {await rpc.connect();const result=await rpc.request('opencraft/personal-assistant/models',{},current.signal);
        if(!current.signal.aborted&&epoch===modelEpoch.current)setCatalog(result);
      } catch {if(!current.signal.aborted&&epoch===modelEpoch.current)warn();}
      finally {if(!current.signal.aborted&&epoch===modelEpoch.current)setModelsLoading(false);}
    }
    useEffect(()=>{if(!details||!claimed)setConfirmStop(false);if(claimed&&details&&mode==='agents')void loadModels();return()=>{modelEpoch.current++;};},[assistant?.binding.botId,claimed,details]);
    const selection=assistant?.model?JSON.stringify([assistant.model.providerId,assistant.model.modelId]):'';
    const modelOptions=(catalog?.models??[]).map(model=>({value:JSON.stringify([model.providerId,model.modelId]),label:model.label,disabled:false}));
    if(selection&&!modelOptions.some(m=>m.value===selection))modelOptions.unshift({value:selection,label:f('modelUnavailable'),disabled:true});
    async function selectModel(value:string) {
      const current=lifetime.current;if(!current||signal.aborted||!statusResource.get().authoritative||!assistant||modelBusy.current||busy.current)return;
      const model=catalog?.models.find(m=>JSON.stringify([m.providerId,m.modelId])===value);if(!model)return;
      modelBusy.current=true;setModelSaving(true);const release=statusResource.hold();
      try {const result=await rpc.request('opencraft/personal-assistant/model/set',{model:{providerId:model.providerId,modelId:model.modelId},expectedRevision:assistant.modelRevision},current.signal);
        if(!current.signal.aborted){setStatus(result);}
      }catch{if(!current.signal.aborted)reportError?.({key:'assistant-model',message:f('modelFailed')});}
      finally {modelBusy.current=false;release();if(!current.signal.aborted)setModelSaving(false);}
    }
    function GroupMeta({at}:{at:number}) {return <span className="people-group-meta"><time dateTime={new Date(at).toISOString()}>{new Date(at).toDateString()===new Date().toDateString()?intl.formatTime(at,{hour:'2-digit',minute:'2-digit'}):intl.formatDate(at,{month:'numeric',day:'numeric'})}</time></span>;}
    function Unread({count}:{count?:number}) {return count?<span className="people-unread">{count>99?'99+':count}</span>:null;}
    const assistantGroup=groupsState.value?.all.find(g=>g.id===status?.channelId);
    const assistantRow=claimed&&(!query.trim()||f('assistant').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))?<div className="people-group-entry"><ObjectRowButton className="people-group" aria-current={host.activeView?.viewId===chatViewId&&parseChannelResource(host.activeView.resourceUri)?.id===status?.channelId?'page':undefined} aria-label={f('assistant')} disabled={pending||!statusState.authoritative||!groupsState.authoritative} onClick={()=>void action('open')}><span className="people-group-content"><span className="people-group-badge-anchor"><CompanionAvatar id={assistant!.actorId}/><Unread count={assistantGroup?.unreadCount}/></span><span className="people-member-copy"><strong>{f('assistant')}</strong><small>{assistantGroup?.latestMessage?.text||f('ready')}</small></span>{assistantGroup?.latestMessage?<GroupMeta at={assistantGroup.latestMessage.at}/>:null}</span></ObjectRowButton></div>:null;
    // People, plus the Agents you can reach: a Server's Agents join the directory as members do.
    // While not searching, everyone in one of your teams is shown under that team instead.
    const [teamed,setTeamed]=useState<ReadonlySet<string>>(new Set());
    const visiblePeople=people.filter(person=>(person.kind==='human'||person.canMessage)&&(search||!teamed.has(person.actorId)));
    const memberRow=(person:Pick<ChannelPerson,'actorId'|'displayName'|'kind'|'avatar'>,reachable:boolean,trailing?:import('react').ReactNode)=>{
      const row=<><Avatar person={person}/><div className="people-member-copy"><span>{person.displayName}</span></div><small className="people-kind">{f(person.kind)}</small></>;
      // Someone you may message opens your direct conversation; to a team's Agent that message is a dispatch.
      const main=reachable?<ObjectRowButton key={person.actorId} className="people-member people-member--open" aria-busy={openingPerson===person.actorId} disabled={openingPerson===person.actorId}
        onClick={()=>void openDirect(person.actorId)}>{row}</ObjectRowButton>:<div className="people-member" key={person.actorId}>{row}</div>;
      return trailing?<>{main}{trailing}</>:main;
    };
    const visibleGroups=groups.filter(group=>group.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const selectedChannel = host.activeView?.viewId === chatViewId ? parseChannelResource(host.activeView.resourceUri)?.id : undefined;
    const phaseText=status?.assistant?.state==='claimed'?f(status.runtime.phase):f('stopped');
    return <StandardPage regions={regions} header={<StandardPageTitle>{intl.formatMessage(mode==='agents'?agentsTitle:title)}</StandardPageTitle>} className={"people-page"+(mode==='inbox'?' people-page--inbox':'')+(memoryOpen&&claimed?' people-page--memory':'')}>
      {mode==='agents'?<p className="people-page__description">{f('agentsAbout')}</p>:null}
      {mode==='inbox'?<div className="people-toolbar">
        <div className="people-toolbar-search"><SettingsTextInput aria-label={f('searchAll')} placeholder={f('searchAll')} value={query} onChange={e=>setQuery(e.target.value)} maxLength={128}/>
        <CreateGroupButton client={runtime.client} reportError={reportError} onCreated={group=>{void groupsResource.refresh();host.openView(chatViewId,'opencraft-channel:'+group.id);}}/></div>
        <SegmentedControl appearance="toolbar" width="content" label={intl.formatMessage(title)} value={tab} onValueChange={setTab} options={[{value:'groups',label:f('groups')},{value:'work',label:intl.formatMessage({id:'crew.work.label',defaultMessage:'Work'})},{value:'members',label:f('members')}]}/>
      </div>:null}
      {mode==='agents'?<ManagedBots rpc={rpc} signal={signal} onOpen={id=>host.openView(chatViewId,'opencraft-channel:'+id)}/>:null}
      {mode==='agents'?<div inert={!statusState.authoritative&&!!status} data-history-presentation={!statusState.authoritative&&!!status?'warm-loading':'none'}>
      {!status?(failed?<p className="people-status" role="status">{f('failed')}</p>:<SkeletonRows count={1} variant="card"/>):null}
      {assistant?<SettingsSection title={f('myAgents')} className={memoryOpen?"people-memory-section":undefined}><section className={"people-assistant"+(memoryOpen?" people-assistant--memory":"")} aria-label={f('personal')}>
        <div className="people-assistant-summary">
          <CompanionAvatar id={assistant.actorId}/>
          <div className="people-member-copy"><strong>{f('personal')}</strong><small>{phaseText}</small></div>
          {!claimed?<SettingsButton variant="primary" disabled={pending} loading={activeAction==='claim'} onClick={()=>{setDetails(true);void action('claim');}}>{f('reclaim')}</SettingsButton>:
            status!.runtime.phase==='config_required'&&!details&&!memoryOpen?<SettingsButton variant="primary" onClick={()=>setDetails(true)}>{f('chooseModel')}</SettingsButton>:
            <SettingsButton variant="quiet" disabled={pending||modelSaving} loading={activeAction==='open'} onClick={()=>void action('open')}>{f('open')}</SettingsButton>}
          {claimed?<SettingsButton variant="quiet" aria-expanded={memoryOpen} onClick={()=>{if(memoryOpen&&memoryCloseGuard.current&&!memoryCloseGuard.current())return;if(!memoryOpen)setDetails(false);setMemoryOpen(v=>!v);}}>{f('memory')}</SettingsButton>:null}
          {claimed?<SettingsIconButton label={details?f('closeDetails'):f('manage')} aria-expanded={details} aria-controls="people-assistant-details" onClick={()=>{if(memoryOpen){if(memoryCloseGuard.current&&!memoryCloseGuard.current())return;setMemoryOpen(false);setDetails(true);}else setDetails(v=>!v);}}><SettingsGearIcon/></SettingsIconButton>:null}
        </div>
        {memoryOpen&&claimed?<AssistantMemory key={assistant.binding.botId+':'+assistant.binding.assignmentId} rpc={rpc} binding={assistant.binding} registerCloseGuard={guard=>{memoryCloseGuard.current=guard;return()=>{if(memoryCloseGuard.current===guard)memoryCloseGuard.current=null;};}}/>:null}
        {details&&claimed?<div id="people-assistant-details" className="people-assistant-details"><SettingsGroup>
          <SettingsRow label={f('model')} description={catalog?.models.length?f('modelAbout'):modelsLoading?f('loading'):catalog?.available===false?f('modelServiceUnavailable'):catalog?f('noModels'):null}>
            <SettingsChoiceSelect label={f('model')} value={selection} options={modelOptions} placeholder={f('chooseModel')}
              disabled={modelSaving||pending||!catalog?.models.length} onValueChange={value=>void selectModel(value)}/>
          </SettingsRow></SettingsGroup>
          <AssistantThreadSettings key={assistant.binding.botId} rpc={rpc} reportError={reportError}/>
          {confirmStop?<div className="people-confirm" role="group" aria-label={f('stop')}>
            <p>{f('stopConfirm')}</p>
            <div className="people-actions">
              <SettingsButton variant="quiet" disabled={pending} onClick={()=>setConfirmStop(false)}>{f('cancel')}</SettingsButton>
              <SettingsButton variant="danger" disabled={pending||modelSaving} loading={activeAction==='revoke'} onClick={()=>void action('revoke')}>{f('stopConfirmAction')}</SettingsButton>
            </div>
          </div>:<div className="people-actions">
            {status!.runtime.phase==='unavailable'?<SettingsButton disabled={pending||modelSaving} onClick={()=>void action('retry')}>{f('retry')}</SettingsButton>:null}
            <SettingsButton variant="quiet" disabled={pending||modelSaving} onClick={()=>setConfirmStop(true)}>{f('stop')}</SettingsButton>
          </div>}
        </div>:null}
      </section></SettingsSection>:null}
      {status&&!assistant?<SettingsSection title={f('available')}>
        <section className="people-assistant" aria-label={f('personal')}>
          <div className="people-assistant-summary">
            <span className="agents-template-glyph" aria-hidden="true"><AgentIcon/></span>
            <div className="people-member-copy"><strong>{f('personal')}</strong><small>{f('personalAbout')}</small></div>
            <SettingsButton variant="primary" disabled={pending} loading={activeAction==='claim'} onClick={()=>{setDetails(true);void action('claim');}}>{f('hire')}</SettingsButton>
          </div>
        </section>
      </SettingsSection>:null}</div>:tab==='groups'?<section className="people-stream" aria-label={f('groups')} aria-busy={groupsPending}>
        {groupsPending?<SkeletonRows count={4} variant="group"/>:null}
        {assistantRow}
        {visibleGroups.map(group=><div className="people-group-entry" key={group.id}><ObjectRowButton className="people-group" aria-current={selectedChannel===group.id?'page':undefined} aria-label={group.title} disabled={!groupsState.authoritative} onClick={()=>host.openView(chatViewId,'opencraft-channel:'+group.id)}><span className="people-group-content">
          <span className="people-group-badge-anchor"><span className="people-group-avatar" aria-hidden="true" data-count={Math.min(groupMembers[group.id]?.length??0,9)||1}>{groupMembers[group.id]?.length?groupMembers[group.id]!.map(member=><Avatar key={member.actorId} person={{...member,kind:member.actorKind==='session'?'bot':'human'}}/>):<DefaultFace seed={group.title} tint="#b4bac2"/>}</span><Unread count={group.unreadCount}/></span>
          <span className="people-member-copy"><strong>{group.title}</strong><small>{!!group.mentionUnreadCount&&<><span className="people-mention">[{intl.formatMessage({id:'im.channels.mentionedMe',defaultMessage:'Mentioned you'})}]</span>{' '}</>}{group.latestMessage?.text||f('image')}</small></span>
          <GroupMeta at={group.latestMessage!.at}/>
        </span></ObjectRowButton></div>)}
        <div role="status" className="people-status">{groupsState.failed?<>{f('failed')} <SettingsButton variant="quiet" onClick={()=>void groupsResource.refresh()}>{f('retry')}</SettingsButton></>:!groupsPending&&!visibleGroups.length&&!assistantRow?f('noGroups'):null}</div>
      </section>:tab==='work'?<Suspense fallback={<SkeletonRows count={3} variant="group"/>}><CrewWorkList rpc={rpc} signal={signal} reportError={reportError} placeholder={<SkeletonRows count={3} variant="group"/>} onOpenChat={id=>host.openView(chatViewId,'opencraft-channel:'+id)}/></Suspense>:<section className="people-stream" aria-label={f('members')}>
        {search?null:<CrewTeams rpc={rpc} signal={signal} reportError={reportError} onTeamed={setTeamed}
          renderMember={(member,reachable,trailing)=>{const known=people.find(p=>p.actorId===member.actorId);
            return memberRow({actorId:member.actorId,displayName:member.displayName,kind:member.kind==='session'?'bot':'human',...(known?.avatar?{avatar:known.avatar}:{})},reachable,trailing);}}/>}
        {!search&&teamed.size&&visiblePeople.length?<h3 className="crew-team__others">{intl.formatMessage({id:'crew.teams.others',defaultMessage:'Other people'})}</h3>:null}
        <div className="people-members" aria-busy={listing}>
          {listing&&!people.length?<SkeletonRows count={4} variant="member"/>:null}
          {visiblePeople.map(person=>memberRow(person,person.canMessage))}
        </div>
        <div role="status" className="people-status">{listFailed?<>{f('listFailed')} <SettingsButton variant="quiet" onClick={()=>setListRetry(n=>n+1)}>{f('retry')}</SettingsButton></>:!listing&&!visiblePeople.length&&(search||!teamed.size)?f('empty'):null}</div>
        {next?<SettingsButton disabled={listing} onClick={()=>{
          const epoch=listEpoch.current,controller=lifetime.current;if(!controller)return;setListing(true);
          void rpc.request('opencraft/channels/people/list',{after:next,...(search?{query:search}:{})},controller.signal).then(result=>{
            if(!controller.signal.aborted&&epoch===listEpoch.current){setPeople(rows=>[...rows,...result.people.filter(p=>!rows.some(r=>r.actorId===p.actorId))]);setNext(result.next);}
          }).catch(()=>{if(!controller.signal.aborted)warn();}).finally(()=>{if(!controller.signal.aborted&&epoch===listEpoch.current)setListing(false);});
        }}>{f('more')}</SettingsButton>:null}
      </section>}
    </StandardPage>;
  }
  function Scoped({children}:{children:import('react').ReactNode}) { const active=useSyncExternalStore(runtime.subscribeScope,runtime.getScope,runtime.getScope);return active?children:null; }
  function Page(props:ExtensionSettingsViewProps){return <Scoped><DirectoryPage {...props} mode="inbox"/></Scoped>;}
  function AgentsPage(props:ExtensionSettingsViewProps){return <Scoped><DirectoryPage {...props} mode="agents"/></Scoped>;}
  const RawEntry=Entry;function ScopedEntry(props:ExtensionSettingsViewProps){return <Scoped><RawEntry {...props}/></Scoped>;}
  return {Entry:ScopedEntry,Page,AgentsPage};
}

/** Sidebar entry glyphs share the Shell's muted section palette (--sidebar-icon-*). */
