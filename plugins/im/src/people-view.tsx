import { isTouchPresentation, subscribeTouchPresentation } from '@opencraft/design-system-web/input-presentation';
import {
  AssistantsSurface,
  InboxSurface,
  ValdiSurface,
  type AssistantActorCardItem,
  type AssistantPresetCardItem,
  type InboxGroupItem,
} from '@opencraft/design-system-web/valdi';
import { PeopleEntryGlyph as EntryGlyph } from '@opencraft/design-system-web/action-icons';
import {
  ManagedBots,
  type AssistantActorBusyState,
  type ManagedBotsActions,
} from './managed-bots';
// Crew work and the desk load when the Work tab is first opened, or during idle warm-up.
const loadCrewWorkView = () => import('./crew-work-view');
const CrewWorkList = lazy(() => loadCrewWorkView().then(m => ({ default: m.CrewWorkList })));
import { getChannelRuntime, type ChannelRuntime, type ChannelRead, type ChannelReadState } from './channel-runtime';
import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AssistantPresetId, ChannelGroupCreateOption, ChannelPerson } from '@opencraft/appserver-protocol';
import { NavigationList, NavigationItem } from '@opencraft/design-system-web/navigation';
import { StandardPage, StandardPageTitle, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';
import type { ChannelRpc } from './channel-client';
import { CreateGroupButton } from './channel-group-controls';
import { parseChannelResource } from './channel-search';
import {
  formatAssistantDisplayName,
  formatEnvironmentLabel,
  normalizeAssistantActorList,
  projectAvailableAssistantPresets,
} from './assistant-actors';
import './people.scss';

export const PEOPLE_VIEW_ID = 'opencraft.im.people';
export const AGENTS_VIEW_ID = 'opencraft.im.agents';
const agentsTitle = { id: 'agents.title', defaultMessage: 'Assistants' };
const title = { id: 'people.title', defaultMessage: 'Inbox' };

const messages = {
  memory: { id: 'people.memory.title', defaultMessage: 'Memory' },
  agentsAbout: {
    id: 'agents.about',
    defaultMessage: 'Hire an assistant to handle everyday work with you. Each assistant keeps its own private memory.',
  },
  myAgents: { id: 'agents.mine', defaultMessage: 'My assistants' },
  available: { id: 'agents.available', defaultMessage: 'Available to hire' },
  hire: { id: 'agents.hire', defaultMessage: 'Hire' },
  personal: { id: 'agents.personal', defaultMessage: 'Personal assistant' },
  personalAbout: {
    id: 'agents.personalAbout',
    defaultMessage:
      'Manages tasks, remembers your preferences and reads the group chats and conversations you can access. The assistant and its memory belong only to you.',
  },
  presetSingleton: { id: 'agents.presetSingleton', defaultMessage: 'Built-in preset · 1 per account' },
  presetBadge: { id: 'agents.presetBadge', defaultMessage: 'Personal preset' },
  emptyMine: {
    id: 'agents.emptyMine',
    defaultMessage: 'No assistants hired yet. Hire a preset below or create a new assistant.',
  },
  groups: { id: 'people.groups', defaultMessage: 'Group chats' },
  noGroups: { id: 'people.noGroups', defaultMessage: 'No recent group messages.' },
  searchAll: { id: 'people.searchAll', defaultMessage: 'Search groups, people and assistants' },
  image: { id: 'people.image', defaultMessage: '[Image]' },
  ready: { id: 'people.ready', defaultMessage: 'Open to start a conversation' },
  chooseModel: { id: 'people.chooseModel', defaultMessage: 'Choose a model' },
  members: { id: 'people.members', defaultMessage: 'Members' },
  assistant: { id: 'people.assistant', defaultMessage: 'My assistant' },
  stopped: { id: 'people.stopped', defaultMessage: 'Paused. The assistant and its memory are kept.' },
  config_required: { id: 'people.configRequired', defaultMessage: 'Choose a model and the assistant can start working.' },
  unavailable: { id: 'people.unavailable', defaultMessage: 'The assistant can’t run right now. Its data is kept.' },
  starting: { id: 'people.starting', defaultMessage: 'Starting…' },
  queued: { id: 'people.queued', defaultMessage: 'Waiting to start…' },
  running: { id: 'people.running', defaultMessage: 'Ready. Keeps working after you close this page.' },
  retrying: { id: 'people.retrying', defaultMessage: 'Couldn’t start. Retrying automatically…' },
  retry: { id: 'people.retry', defaultMessage: 'Retry' },
  loading: { id: 'people.loading', defaultMessage: 'Loading…' },
  failed: { id: 'people.failed', defaultMessage: 'Can’t connect right now. Retrying…' },
  actionFailed: { id: 'people.actionFailed', defaultMessage: 'That didn’t go through. Try again.' },
  listFailed: { id: 'people.listFailed', defaultMessage: 'Members could not be loaded.' },
  human: { id: 'people.human', defaultMessage: 'Person' },
  bot: { id: 'people.bot', defaultMessage: 'Assistant' },
  more: { id: 'people.more', defaultMessage: 'Load more' },
  empty: { id: 'people.empty', defaultMessage: 'No matching members.' },
};

function useResource<T>(resource: ChannelRead<T>, interval: number): ChannelReadState<T> {
  const state = useSyncExternalStore(resource.subscribe, resource.get, resource.get);
  useEffect(() => {
    if (!interval) return;
    void resource.refresh();
    const poll = setInterval(() => {
      if (document.visibilityState !== 'hidden') void resource.refresh();
    }, interval);
    return () => clearInterval(poll);
  }, [resource, interval]);
  return state;
}

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Shape-preserving placeholders. CSS keeps them invisible for a short grace
 * period, so a warm or fast read never flashes a loading frame. */
function SkeletonLine({ width }: { width: string }) {
  return <span className="people-skeleton people-skeleton-line" style={{ inlineSize: width }} aria-hidden="true" />;
}
function SkeletonRows({ count, variant }: { count: number; variant: 'group' | 'member' | 'card' }) {
  return (
    <div className={'people-skeleton-rows people-skeleton-rows--' + variant} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="people-skeleton-row" key={i}>
          <span className="people-skeleton people-skeleton-avatar" />
          <span className="people-skeleton-copy">
            <SkeletonLine width={['9em', '12em', '7em', '10em'][i % 4]!} />
            {variant === 'member' ? null : <SkeletonLine width={['16em', '11em', '14em'][i % 3]!} />}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One directory replica per authenticated extension lifetime. No claim on mount/login. */
export function createPeopleViews(
  transport: ChannelRpc,
  activation: AbortSignal,
  chatViewId: string,
  runtime: ChannelRuntime = getChannelRuntime(fetch, transport, activation),
  groupCreateOptions: readonly ChannelGroupCreateOption[] = [],
) {
  const { rpc, signal } = runtime;
  let snapshot: { people: ChannelPerson[]; loaded: boolean; failed: boolean } = {
    people: [],
    loaded: false,
    failed: false,
  };
  const listeners = new Set<() => void>();
  let refreshing: Promise<void> | undefined;
  const getSnapshot = () => snapshot;
  const emit = () => listeners.forEach(fn => fn());

  async function refresh() {
    if (refreshing || signal.aborted) return refreshing;
    return (refreshing = (async () => {
      try {
        await rpc.connect();
        const result = await rpc.request('opencraft/channels/people/list', {}, signal);
        if (!signal.aborted) {
          snapshot = { people: result.people, loaded: true, failed: false };
          emit();
        }
      } catch {
        if (!signal.aborted) {
          snapshot = { ...snapshot, failed: true };
          emit();
        }
      }
    })().finally(() => {
      refreshing = undefined;
    }));
  }

  const timer = setInterval(() => {
    if (listeners.size) void refresh();
  }, 30000);
  const warmWorkTimer = setTimeout(() => {
    if (!signal.aborted) void loadCrewWorkView();
  }, 350);
  const retirePeople = () => {
    clearInterval(timer);
    clearTimeout(warmWorkTimer);
    snapshot = { people: [], loaded: false, failed: true };
    emit();
    listeners.clear();
  };
  signal.addEventListener('abort', retirePeople, { once: true });
  if (signal.aborted) retirePeople();

  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    void refresh();
    return () => {
      listeners.delete(fn);
    };
  };

  const groupsResource = runtime.directory;
  const assistantsResource = runtime.assistants;

  function Entry({ host }: ExtensionSettingsViewProps) {
    const intl = useIntl();
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return (
      <NavigationList label={intl.formatMessage(title)} inset="contained">
        <NavigationItem
          aria-current={[PEOPLE_VIEW_ID, chatViewId].includes(host.activeView?.viewId ?? '') ? 'page' : undefined}
          onClick={() => host.openView(PEOPLE_VIEW_ID)}
        >
          <EntryGlyph kind="inbox" />
          <span data-navigation-label="" className="people-entry-label">
            {intl.formatMessage(title)}
          </span>
        </NavigationItem>
        <NavigationItem
          aria-current={host.activeView?.viewId === AGENTS_VIEW_ID ? 'page' : undefined}
          onClick={() => host.openView(AGENTS_VIEW_ID)}
        >
          <EntryGlyph kind="assistant" />
          <span data-navigation-label="" className="people-entry-label">
            {intl.formatMessage(agentsTitle)}
          </span>
        </NavigationItem>
      </NavigationList>
    );
  }

  function DirectoryPage({
    host,
    reportError,
    regions,
    mode,
  }: ExtensionSettingsViewProps & { mode: 'inbox' | 'agents' }) {
    const intl = useIntl();
    const f = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
    const fb = (key: string, defaultMessage: string) =>
      intl.formatMessage({ id: 'bots.manage.' + key, defaultMessage });

    const [openingPerson, setOpeningPerson] = useState<string | null>(null);
    const [openingBotId, setOpeningBotId] = useState<string | null>(null);
    const [tab, setTab] = useState('groups');
    const [listRetry, setListRetry] = useState(0);
    const [actorMutation, setActorMutation] = useState<AssistantActorBusyState>({
      busy: false,
      activeBotId: null,
      activePresetId: null,
      operation: null,
    });

    const groupsState = useResource(groupsResource, 0);
    const assistantsState = useResource(assistantsResource, 0);
    const groups = groupsState.value?.groups ?? [];
    const groupsPending = !groupsState.value && !groupsState.failed;

    const lifetime = useRef<AbortController | null>(null);
    const [query, setQuery] = useState('');
    const search = useDebounced(query.trim(), 200);
    const [people, setPeople] = useState<ChannelPerson[]>(() => snapshot.people);
    const [next, setNext] = useState<string | null>(null);
    const [listing, setListing] = useState(!snapshot.loaded);
    const [listFailed, setListFailed] = useState(false);
    const listEpoch = useRef(0);
    const warn = () => reportError?.({ key: 'personal-assistant', message: f('actionFailed') });

    useEffect(() => {
      const controller = new AbortController();
      lifetime.current = controller;
      const retire = () => controller.abort();
      signal.addEventListener('abort', retire, { once: true });
      if (signal.aborted) retire();
      return () => {
        signal.removeEventListener('abort', retire);
        controller.abort();
        lifetime.current = null;
      };
    }, []);

    const assistantRows = assistantsState.value;
    const assistantsLoading = !assistantRows && !assistantsState.failed;
    const assistantsFailed = !assistantRows && assistantsState.failed;
    const normalizedActors = normalizeAssistantActorList(assistantRows ?? []);
    const availablePresets = projectAvailableAssistantPresets(assistantRows ?? []);
    const actorRevisionKey = normalizedActors.map(a => `${a.botId}:${a.paused ? 0 : 1}`).join(',');

    useEffect(() => {
      if (mode === 'agents') return;
      const controller = new AbortController();
      const epoch = ++listEpoch.current;
      const request = combineAbortSignals([signal, controller.signal]);
      setListing(true);
      setListFailed(false);
      void rpc
        .connect()
        .then(() => rpc.request('opencraft/channels/people/list', search ? { query: search } : {}, request.signal))
        .then(result => {
          if (!controller.signal.aborted && epoch === listEpoch.current) {
            setPeople(result.people);
            setNext(result.next);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setListFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setListing(false);
        });
      return () => {
        controller.abort();
        request.dispose();
      };
    }, [search, actorRevisionKey, listRetry]);

    async function openDirect(actorId: string) {
      if (openingPerson) return;
      setOpeningPerson(actorId);
      try {
        await rpc.connect();
        const channel = await rpc.request('opencraft/channels/direct/open', { actorId }, signal);
        if (!signal.aborted) host.openView(chatViewId, 'opencraft-channel:' + channel.id);
      } catch {
        if (!signal.aborted) {
          reportError?.({
            key: 'people-direct',
            message: intl.formatMessage({
              id: 'people.directFailed',
              defaultMessage: 'Could not open this conversation.',
            }),
          });
        }
      } finally {
        if (!signal.aborted) setOpeningPerson(null);
      }
    }

    async function openAssistantConversation(botId: string, isSingletonPreset: boolean) {
      const current = lifetime.current;
      if (!current || signal.aborted || openingBotId) return;
      setOpeningBotId(botId);
      try {
        await rpc.connect();
        let result = await rpc
          .request('opencraft/personal-assistant/open', { botId }, current.signal)
          .catch(async err => {
            if (isSingletonPreset) return rpc.request('opencraft/personal-assistant/open', {}, current.signal);
            throw err;
          });
        if (!result?.channel?.id && isSingletonPreset) {
          result = await rpc.request('opencraft/personal-assistant/open', {}, current.signal);
        }
        if (!current.signal.aborted && result?.channel?.id) {
          host.openView(chatViewId, 'opencraft-channel:' + result.channel.id);
        }
      } catch {
        if (!current.signal.aborted) warn();
      } finally {
        if (!current.signal.aborted) setOpeningBotId(null);
      }
    }

    const visiblePeople = people.filter(person => person.kind === 'human' || person.canMessage);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleGroups = groups.filter(group => group.title.toLocaleLowerCase().includes(normalizedQuery));
    const selectedChannel =
      host.activeView?.viewId === chatViewId ? parseChannelResource(host.activeView.resourceUri)?.id : undefined;
    const touch = useSyncExternalStore(
      onChange => subscribeTouchPresentation(document, onChange),
      () => isTouchPresentation(document),
      () => false,
    );
    const createGroupTriggerRef = useRef<HTMLDivElement | null>(null);
    const managedBotsActionsRef = useRef<ManagedBotsActions | null>(null);

    const formatAt = (at: number) =>
      new Date(at).toDateString() === new Date().toDateString()
        ? intl.formatTime(at, { hour: '2-digit', minute: '2-digit' })
        : intl.formatDate(at, { month: 'numeric', day: 'numeric' });

    const personalLabel = f('personal');
    const inboxAssistantEntries: InboxGroupItem[] = normalizedActors
      .filter(actor => !actor.paused && (actor.isSingletonPreset || Boolean(actor.channelId)))
      .flatMap((actor): InboxGroupItem[] => {
        const displayTitle = actor.isSingletonPreset && (!actor.rawName || actor.rawName === 'Personal assistant')
          ? f('assistant')
          : formatAssistantDisplayName(actor, personalLabel);
        if (normalizedQuery && !displayTitle.toLocaleLowerCase().includes(normalizedQuery)) {
          return [];
        }
        const dmChannel = actor.channelId ? groupsState.value?.all.find(g => g.id === actor.channelId) : undefined;
        return [{
          id: `assistant:${actor.botId}`,
          title: displayTitle,
          preview: dmChannel?.latestMessage?.text || f('ready'),
          ...(dmChannel?.latestMessage ? { metaText: formatAt(dmChannel.latestMessage.at) } : {}),
          ...(dmChannel?.unreadCount
            ? { unreadText: dmChannel.unreadCount > 99 ? '99+' : String(dmChannel.unreadCount) }
            : {}),
          selected: Boolean(actor.channelId && selectedChannel === actor.channelId),
          isAssistant: true,
          disabled:
            openingBotId === actor.botId || !assistantsState.authoritative || !groupsState.authoritative,
        }];
      });

    const inboxGroupsList: InboxGroupItem[] = [
      ...inboxAssistantEntries,
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

    const actorCardItems: AssistantActorCardItem[] = normalizedActors.map(actor => {
      const displayTitle = formatAssistantDisplayName(actor, personalLabel);
      const badgeText =
        actor.isSingletonPreset && displayTitle !== personalLabel ? f('presetBadge') : undefined;
      const phaseSummary = actor.paused ? fb('paused', 'Paused') : f(actor.phase);
      const envSummary = formatEnvironmentLabel(actor.environment, fb('local', 'Local machine'));
      const modelSummary = actor.model?.modelId ?? fb('noModel', 'No model selected');
      const statusText = `${phaseSummary} · ${envSummary} · ${modelSummary}`;
      const configRequired = !actor.paused && actor.phase === 'config_required';
      const primaryActionKind: AssistantActorCardItem['primaryActionKind'] = actor.paused
        ? 'resume'
        : configRequired
          ? 'choose-model'
          : 'chat';
      const primaryActionLabel = actor.paused
        ? fb('resume', 'Resume')
        : configRequired
          ? f('chooseModel')
          : fb('chat', 'Chat');
      const isTargetBusy = actorMutation.activeBotId === actor.botId || openingBotId === actor.botId;
      return {
        id: actor.botId,
        title: displayTitle,
        badgeText,
        statusText,
        dutiesText: actor.duties.trim() || undefined,
        paused: actor.paused,
        configRequired,
        primaryActionKind,
        primaryActionLabel,
        memoryLabel: f('memory'),
        settingsLabel: fb('settings', 'Settings'),
        pauseLabel: fb('pause', 'Pause'),
        busy: actorMutation.busy || Boolean(openingBotId),
        activeOperation: isTargetBusy ? (openingBotId === actor.botId ? 'open' : actorMutation.operation) : null,
      };
    });

    const presetCardItems: AssistantPresetCardItem[] = availablePresets.map(preset => ({
      id: preset.id,
      title: preset.id === 'personal-assistant' ? personalLabel : preset.id,
      description: f('personalAbout'),
      cardinalityLabel: f('presetSingleton'),
      hireLabel: f('hire'),
      hiring: actorMutation.activePresetId === preset.id && actorMutation.operation === 'hire',
      disabled: actorMutation.busy || assistantsLoading || assistantsFailed,
    }));

    const surfaceError = assistantsFailed
      ? f('failed')
      : actorMutation.error;

    return (
      <StandardPage
        regions={regions}
        header={<StandardPageTitle>{intl.formatMessage(mode === 'agents' ? agentsTitle : title)}</StandardPageTitle>}
        className={'people-page' + (mode === 'inbox' ? ' people-page--inbox' : '')}
      >
        {mode === 'agents' ? (
          <div className="managed-bots">
            <p className="people-page__description">{f('agentsAbout')}</p>
            <ManagedBots
              rpc={rpc}
              signal={signal}
              onOpen={id => host.openView(chatViewId, 'opencraft-channel:' + id)}
              botsResource={assistantsResource}
              actionsRef={managedBotsActionsRef}
              onStateChange={setActorMutation}
            />
            <ValdiSurface
              component={AssistantsSurface}
              style={{ width: '100%' }}
              viewModel={{
                touch,
                loading: assistantsLoading,
                errorText: surfaceError,
                retryLabel: f('retry'),
                myAgentsTitle: f('myAgents'),
                myAgentsDescription: fb(
                  'privacy',
                  'Each assistant has its own private conversation and memory. Group membership does not grant access to private memory.',
                ),
                createLabel: fb('create', 'New assistant'),
                createDisabled: actorMutation.busy || assistantsLoading || assistantsFailed,
                emptyMineText: f('emptyMine'),
                actors: actorCardItems,
                availableTitle: f('available'),
                presets: presetCardItems,
                onCreateActor: () => managedBotsActionsRef.current?.create(),
                onRetry: () => void assistantsResource.refresh(),
                onHirePreset: presetId => void managedBotsActionsRef.current?.hirePreset(presetId as AssistantPresetId),
                onPrimaryAction: botId => {
                  const actor = normalizedActors.find(item => item.botId === botId);
                  if (!actor) return;
                  if (actor.paused) {
                    void managedBotsActionsRef.current?.togglePause(botId);
                  } else if (actor.phase === 'config_required') {
                    managedBotsActionsRef.current?.openSettings(botId);
                  } else {
                    void openAssistantConversation(botId, actor.isSingletonPreset);
                  }
                },
                onOpenMemory: botId => managedBotsActionsRef.current?.openMemory(botId),
                onOpenSettings: botId => managedBotsActionsRef.current?.openSettings(botId),
                onTogglePause: botId => void managedBotsActionsRef.current?.togglePause(botId),
              }}
            />
          </div>
        ) : (
          <>
            <div
              ref={createGroupTriggerRef}
              style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none', opacity: 0 }}
              aria-hidden="true"
            >
              <CreateGroupButton
                client={runtime.client}
                options={groupCreateOptions}
                reportError={reportError}
                onCreated={group => {
                  void groupsResource.refresh();
                  host.openView(chatViewId, 'opencraft-channel:' + group.id);
                }}
              />
            </div>
            <ValdiSurface
              component={InboxSurface}
              style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
              viewModel={{
                touch,
                title: intl.formatMessage(title),
                activeTab: tab as 'groups' | 'work' | 'members',
                searchQuery: query,
                searchPlaceholder: f('searchAll'),
                clearSearchLabel: intl.formatMessage({
                  id: 'settings.remoteAccess.clearInput',
                  defaultMessage: 'Clear',
                }),
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
                  if (isAssistant && id.startsWith('assistant:')) {
                    const botId = id.slice('assistant:'.length);
                    const actor = normalizedActors.find(item => item.botId === botId);
                    void openAssistantConversation(botId, Boolean(actor?.isSingletonPreset));
                  } else {
                    host.openView(chatViewId, 'opencraft-channel:' + id);
                  }
                },
                onRetryGroups: () => void groupsResource.refresh(),
                onOpenMember: id => void openDirect(id),
                onRetryMembers: () => setListRetry(n => n + 1),
                onLoadMoreMembers: next
                  ? () => {
                      const epoch = listEpoch.current;
                      const controller = lifetime.current;
                      if (!controller) return;
                      setListing(true);
                      void rpc
                        .request(
                          'opencraft/channels/people/list',
                          { after: next, ...(search ? { query: search } : {}) },
                          controller.signal,
                        )
                        .then(result => {
                          if (!controller.signal.aborted && epoch === listEpoch.current) {
                            setPeople(rows => [
                              ...rows,
                              ...result.people.filter(p => !rows.some(r => r.actorId === p.actorId)),
                            ]);
                            setNext(result.next);
                          }
                        })
                        .catch(() => {
                          if (!controller.signal.aborted) warn();
                        })
                        .finally(() => {
                          if (!controller.signal.aborted && epoch === listEpoch.current) setListing(false);
                        });
                    }
                  : undefined,
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
          </>
        )}
      </StandardPage>
    );
  }

  function Scoped({ children }: { children: import('react').ReactNode }) {
    const active = useSyncExternalStore(runtime.subscribeScope, runtime.getScope, runtime.getScope);
    return active ? children : null;
  }
  function Page(props: ExtensionSettingsViewProps) {
    return (
      <Scoped>
        <DirectoryPage {...props} mode="inbox" />
      </Scoped>
    );
  }
  function AgentsPage(props: ExtensionSettingsViewProps) {
    return (
      <Scoped>
        <DirectoryPage {...props} mode="agents" />
      </Scoped>
    );
  }
  const RawEntry = Entry;
  function ScopedEntry(props: ExtensionSettingsViewProps) {
    return (
      <Scoped>
        <RawEntry {...props} />
      </Scoped>
    );
  }
  return { Entry: ScopedEntry, Page, AgentsPage };
}
