import { isTouchPresentation, subscribeTouchPresentation } from '@opencraft/design-system-web/input-presentation';
import { AssistantsSurface, InboxSurface, ValdiSurface } from '@opencraft/design-system-web/valdi';
import { PeopleDefaultFaceArtwork as DefaultFace, PeopleEntryGlyph as EntryGlyph } from "@opencraft/design-system-web/action-icons";
import {ManagedBots, type ManagedBotsActions} from './managed-bots';
import { CrewTeams } from './crew-teams';
// Crew work and the desk load when the Work tab is first opened, or during idle warm-up.
const loadCrewWorkView=()=>import('./crew-work-view');
const CrewWorkList=lazy(()=>loadCrewWorkView().then(m=>({default:m.CrewWorkList})));
import { getChannelRuntime, type ChannelRuntime, type ChannelRead, type ChannelReadState } from './channel-runtime';
import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { AssistantMemory } from './assistant-memory';
import { AssistantThreadSettings } from './assistant-thread-settings';
import { PeopleIcon, AgentIcon, SettingsGearIcon } from '@opencraft/design-system-web/action-icons';
import { lazy, Suspense, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChannelGroupCreateOption, ChannelPerson, PersonalAssistantStatus, PersonalAssistantModelCatalog } from '@opencraft/appserver-protocol';
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
export function createPeopleViews(transport:ChannelRpc, activation:AbortSignal, chatViewId:string, runtime:ChannelRuntime=getChannelRuntime(fetch,transport,activation), groupCreateOptions:readonly ChannelGroupCreateOption[]=[]) {
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
  const warmWorkTimer=setTimeout(()=>{if(!signal.aborted)void loadCrewWorkView();},350);
  const retirePeople=()=>{clearInterval(timer);clearTimeout(warmWorkTimer);snapshot={people:[],loaded:false,failed:true};emit();listeners.clear();};signal.addEventListener('abort',retirePeople,{once:true});if(signal.aborted)retirePeople();
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
    const touch = useSyncExternalStore(onChange => subscribeTouchPresentation(document, onChange), () => isTouchPresentation(document), () => false);
    const createGroupTriggerRef = useRef<HTMLDivElement | null>(null);
    const managedBotsActionsRef = useRef<ManagedBotsActions | null>(null);
    const botsState = useResource(runtime.bots, 0);
    const fb = (key: string, defaultMessage: string) => intl.formatMessage({ id: 'bots.manage.' + key, defaultMessage });
    const managedBotRows = botsState.value;
    const managedBotsFailed = !managedBotRows && botsState.failed;
    const managedBotsItems = (managedBotRows ?? []).map(row => {
      const a = row.assistant!;
      const envText = a.paused
        ? fb('paused', 'Paused')
        : a.environment?.kind === 'sandbox'
          ? (a.environment.backendId.startsWith('e2b-') ? 'E2B' : a.environment.backendId.toLocaleUpperCase()) + ' · ' + a.environment.templateId
          : fb('local', 'Local machine');
      return {
        id: a.binding.botId,
        title: a.name ?? a.actorId,
        statusText: `${envText} · ${a.model?.modelId ?? fb('noModel', 'No model selected')}`,
        openLabel: fb('chat', 'Chat'),
        settingsLabel: fb('settings', 'Settings'),
        pauseLabel: a.paused ? fb('resume', 'Resume') : fb('pause', 'Pause'),
        busy: false,
      };
    });
    const phaseText=status?.assistant?.state==='claimed'?f(status.runtime.phase):f('stopped');
    const formatAt = (at: number) =>
      new Date(at).toDateString() === new Date().toDateString()
        ? intl.formatTime(at, { hour: '2-digit', minute: '2-digit' })
        : intl.formatDate(at, { month: 'numeric', day: 'numeric' });
    const inboxGroupsList: import("@opencraft/design-system-web/valdi").InboxGroupItem[] = [
      ...(claimed && (!query.trim() || f('assistant').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
        ? [{
            id: status?.channelId ?? 'personal-assistant',
            title: f('assistant'),
            preview: assistantGroup?.latestMessage?.text || f('ready'),
            metaText: assistantGroup?.latestMessage ? formatAt(assistantGroup.latestMessage.at) : undefined,
            unreadText: assistantGroup?.unreadCount ? (assistantGroup.unreadCount > 99 ? '99+' : String(assistantGroup.unreadCount)) : undefined,
            selected: host.activeView?.viewId === chatViewId && parseChannelResource(host.activeView.resourceUri)?.id === status?.channelId,
            isAssistant: true,
            disabled: pending || !statusState.authoritative || !groupsState.authoritative,
          }]
        : []),
      ...visibleGroups.map(group => ({
        id: group.id,
        title: group.title,
        preview: `${group.mentionUnreadCount ? `[${intl.formatMessage({ id: 'im.channels.mentionedMe', defaultMessage: 'Mentioned you' })}] ` : ''}${group.latestMessage?.text || f('image')}`,
        metaText: group.latestMessage ? formatAt(group.latestMessage.at) : undefined,
        unreadText: group.unreadCount ? (group.unreadCount > 99 ? '99+' : String(group.unreadCount)) : undefined,
        selected: selectedChannel === group.id,
        disabled: !groupsState.authoritative,
      })),
    ];
    return <StandardPage regions={regions} header={<StandardPageTitle>{intl.formatMessage(mode==='agents'?agentsTitle:title)}</StandardPageTitle>} className={"people-page"+(mode==='inbox'?' people-page--inbox':'')+(memoryOpen&&claimed?' people-page--memory':'')}>
      {mode === 'agents' ? <>
        <ManagedBots rpc={rpc} signal={signal} onOpen={id => host.openView(chatViewId, 'opencraft-channel:' + id)} botsResource={runtime.bots} actionsRef={managedBotsActionsRef} />
        <ValdiSurface
          component={AssistantsSurface}
          style={{ width: "100%" }}
          viewModel={{
            touch,
            title: intl.formatMessage(agentsTitle),
            subtitle: f('agentsAbout'),
            managedTitle: fb('title', 'Additional assistants'),
            managedDescription: fb('privacy', 'Each assistant has its own private conversation and memory. Group membership does not grant access to private memory.'),
            managedCreateLabel: fb('create', 'New assistant'),
            managedCreateDisabled: !managedBotRows || managedBotsFailed,
            managedLoading: !managedBotRows && !managedBotsFailed,
            managedError: managedBotsFailed ? fb('failed', 'Could not complete the request. Refresh or retry; do not create a new request for an unconfirmed result.') : undefined,
            managedEmptyText: fb('empty', 'Create another assistant with its own identity, model, memory and conversation.'),
            managedBots: managedBotsItems,
            onCreateManagedBot: () => managedBotsActionsRef.current?.create(),
            onRetryManagedBots: () => void runtime.bots.refresh(),
            onOpenManagedBot: id => managedBotsActionsRef.current?.openChat(id),
            onSettingsManagedBot: id => managedBotsActionsRef.current?.openSettings(id),
            onTogglePauseManagedBot: id => managedBotsActionsRef.current?.togglePause(id),
            loading: !status && !failed,
            loadingText: f('loading'),
            failedText: failed ? f('failed') : undefined,
            myAgentsTitle: f('myAgents'),
            availableTitle: f('available'),
            personalTitle: f('personal'),
            personalAbout: f('personalAbout'),
            assistantPresent: Boolean(assistant),
            claimed,
            phaseText,
            configRequired: status?.runtime.phase === 'config_required',
            unavailable: status?.runtime.phase === 'unavailable',
            detailsOpen: details,
            memoryOpen,
            confirmStop,
            pending,
            modelSaving,
            activeAction,
            reclaimLabel: f('reclaim'),
            chooseModelLabel: f('chooseModel'),
            openLabel: f('open'),
            memoryLabel: f('memory'),
            manageLabel: f('manage'),
            closeDetailsLabel: f('closeDetails'),
            hireLabel: f('hire'),
            modelLabel: f('model'),
            modelDescription: catalog?.models.length
              ? f('modelAbout')
              : modelsLoading
                ? f('loading')
                : catalog?.available === false
                  ? f('modelServiceUnavailable')
                  : catalog
                    ? f('noModels')
                    : undefined,
            selectedModel: selection,
            modelOptions: modelOptions.map(opt => ({ id: opt.value, title: opt.label, disabled: opt.disabled })),
            modelDisabled: modelSaving || pending || !catalog?.models.length,
            retryLabel: f('retry'),
            stopLabel: f('stop'),
            stopConfirmText: f('stopConfirm'),
            cancelLabel: f('cancel'),
            stopConfirmActionLabel: f('stopConfirmAction'),
            onClaim: () => { setDetails(true); void action('claim'); },
            onOpenChat: () => void action('open'),
            onToggleMemory: () => {
              if (memoryOpen && memoryCloseGuard.current && !memoryCloseGuard.current()) return;
              if (!memoryOpen) setDetails(false);
              setMemoryOpen(v => !v);
            },
            onToggleDetails: () => {
              if (memoryOpen) {
                if (memoryCloseGuard.current && !memoryCloseGuard.current()) return;
                setMemoryOpen(false);
                setDetails(true);
              } else {
                setDetails(v => !v);
              }
            },
            onSelectModel: value => void selectModel(value),
            onRetry: () => void action('retry'),
            onRequestStop: () => setConfirmStop(true),
            onCancelStop: () => setConfirmStop(false),
            onConfirmStop: () => void action('revoke'),
          }}
        />
        {memoryOpen && claimed && assistant ? (
          <AssistantMemory
            key={assistant.binding.botId + ':' + assistant.binding.assignmentId}
            rpc={rpc}
            binding={assistant.binding}
            registerCloseGuard={guard => {
              memoryCloseGuard.current = guard;
              return () => { if (memoryCloseGuard.current === guard) memoryCloseGuard.current = null; };
            }}
          />
        ) : null}
        {details && claimed && assistant ? <AssistantThreadSettings key={assistant.binding.botId} rpc={rpc} reportError={reportError} /> : null}
      </> : <>
        <div ref={createGroupTriggerRef} style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none', opacity: 0 }} aria-hidden="true">
          <CreateGroupButton
            client={runtime.client}
            options={groupCreateOptions}
            reportError={reportError}
            onCreated={group => { void groupsResource.refresh(); host.openView(chatViewId, 'opencraft-channel:' + group.id); }}
          />
        </div>
        <ValdiSurface
          component={InboxSurface}
          style={{ width: "100%", minWidth: 0, maxWidth: "100%" }}
          viewModel={{
            touch,
            title: intl.formatMessage(title),
            activeTab: tab as 'groups' | 'work' | 'members',
            searchQuery: query,
            searchPlaceholder: f('searchAll'),
            clearSearchLabel: intl.formatMessage({ id: 'settings.remoteAccess.clearInput', defaultMessage: 'Clear' }),
            createGroupLabel: '+',
            showCreateGroup: true,
            groupsLabel: f('groups'),
            workLabel: intl.formatMessage({ id: 'crew.work.label', defaultMessage: 'Work' }),
            membersLabel: f('members'),
            loadingText: f('loading'),
            retryLabel: f('retry'),
            groupsLoading: groupsPending,
            groupsError: groupsState.failed ? f('failed') : undefined,
            emptyGroupsText: f('noGroups'),
            groups: inboxGroupsList,
            membersLoading: listing,
            membersError: listFailed ? f('listFailed') : undefined,
            emptyMembersText: f('empty'),
            members: visiblePeople.map(person => ({
              id: person.actorId,
              displayName: person.displayName,
              kindLabel: f(person.kind),
              isBot: person.kind === 'bot',
              reachable: person.canMessage,
              busy: openingPerson === person.actorId,
            })),
            loadMoreLabel: f('more'),
            hasMoreMembers: Boolean(next),
            onSearchChange: setQuery,
            onCreateGroup: () => createGroupTriggerRef.current?.querySelector('button')?.click(),
            onTabChange: nextTab => setTab(nextTab),
            onOpenGroup: (id, isAssistant) => {
              if (isAssistant) {
                void action('open');
              } else {
                host.openView(chatViewId, 'opencraft-channel:' + id);
              }
            },
            onRetryGroups: () => void groupsResource.refresh(),
            onOpenMember: id => void openDirect(id),
            onRetryMembers: () => setListRetry(n => n + 1),
            onLoadMoreMembers: next ? () => {
              const epoch = listEpoch.current, controller = lifetime.current;
              if (!controller) return;
              setListing(true);
              void rpc.request('opencraft/channels/people/list', { after: next, ...(search ? { query: search } : {}) }, controller.signal).then(result => {
                if (!controller.signal.aborted && epoch === listEpoch.current) {
                  setPeople(rows => [...rows, ...result.people.filter(p => !rows.some(r => r.actorId === p.actorId))]);
                  setNext(result.next);
                }
              }).catch(() => { if (!controller.signal.aborted) warn(); }).finally(() => {
                if (!controller.signal.aborted && epoch === listEpoch.current) setListing(false);
              });
            } : undefined,
          }}
        />
        {tab === 'work' ? (
          <Suspense fallback={<SkeletonRows count={3} variant="group" />}>
            <CrewWorkList
              rpc={rpc}
              signal={signal}
              reportError={reportError}
              placeholder={<SkeletonRows count={3} variant="group" />}
              onOpenChat={id => host.openView(chatViewId, 'opencraft-channel:' + id)}
            />
          </Suspense>
        ) : null}
      </>}
    </StandardPage>;
  }
  function Scoped({children}:{children:import('react').ReactNode}) { const active=useSyncExternalStore(runtime.subscribeScope,runtime.getScope,runtime.getScope);return active?children:null; }
  function Page(props:ExtensionSettingsViewProps){return <Scoped><DirectoryPage {...props} mode="inbox"/></Scoped>;}
  function AgentsPage(props:ExtensionSettingsViewProps){return <Scoped><DirectoryPage {...props} mode="agents"/></Scoped>;}
  const RawEntry=Entry;function ScopedEntry(props:ExtensionSettingsViewProps){return <Scoped><RawEntry {...props}/></Scoped>;}
  return {Entry:ScopedEntry,Page,AgentsPage};
}

/** Sidebar entry glyphs share the Shell's muted section palette (--sidebar-icon-*). */
