import { beginObservedOperation } from "./observability";
import { ThreadPinWriter } from "./thread-pin-writer";
import type { HostScheduleCatalog } from "./scheduled-task-catalog-context";
import type { ConversationScheduleSummary, ConversationSchedulesRequestPort } from "@opencraft/appserver-protocol";
import { ApplicationBrandingRegistry } from "./application-branding";
import { createAppServerContentSearchSource, type ConversationSearchSource } from "./conversation-content-search";
import { IdentityAvatarContributionRegistry } from "./identity-avatar-contributions";
import { useAccountModelDefaults } from "./use-account-model-defaults";
import { readModelSelection, rememberModelSelection } from "./model-selection-preferences";
import { ThreadBadgeContributionRegistry } from "./thread-badge-contributions";
import { ThreadListGroupingContributionRegistry } from "./thread-list-grouping-contributions";
import { TurnNotificationsProvider } from "./turn-notifications-context";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";
// @refresh reset
import {
  AppServerRpcError
} from "@opencraft/appserver-client";
import {
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  type CatalogModel as Model
} from "@opencraft/appserver-protocol";
import type {
  PermissionProfileSummary,
  Project,
  Thread,
} from "@opencraft/appserver-protocol/generated/v2";
import { BlobResourceService } from "@opencraft/blob-resources";
import {
  assertSkillDiscoveryAvailable,
  searchAppServerSkills,
  type FuzzyFileSearchSession,
} from "@opencraft/composer-appserver";
import {
  shouldSearchComposerCatalog,
  type ComposerCatalog,
  type ComposerController,
  type ComposerTarget
} from "@opencraft/composer-core";
import {
  PlatformViewRendererRegistry
} from "@opencraft/extension-react";
import {
  ExtensionSettingsStore,
  type AnnouncementCenter,
  type ExtensionContributionStore
} from "@opencraft/extension-runtime";
import { ImageProcessingService } from "@opencraft/image-processing";
import {
  createConversationReturnProbe,
  HostRuntimeRegistry,
  legacyDirectServerProjectionFromHost,
  projectAppServerThread,
  type AppServerThreadRuntimeLease,
  type AppServerWorkbenchRuntime,
  type AppServerWorkbenchViewSnapshot,
  type ConversationBindingStore,
  type ConversationScopeId,
  type ConversationScopeRegistry,
  type ConversationScopeRegistrySnapshot,
  type HostConnectionProfileStore,
  type ServerRouteLocality,
  type ThreadServerOrigin,
  type WorkbenchThread
} from "@opencraft/workbench-runtime";
import {
  QueryClientProvider,
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react";
import { cachedComposerModelMetadata, composerCapabilitiesOptions, invalidateComposerCapabilities } from "./composer-capabilities-query";
import { catalogCachedAt, managedCatalogDiscoveryPhase, mergeThreadCatalogPages, sidebarThreadCatalogQueryKey, threadCatalogPhase, type HostThreadCatalogState } from "./thread-catalog-query";

import { subscribeHostCatalogReadiness } from "./host-catalog-readiness";
import { canDisplayHostThreadCatalog, canReadHostThreadCatalog, managedHostCatalogSignature, type ManagedHostCatalogSource } from "./host-thread-catalog";
import { PlatformAccountContributionRegistry } from "./platform-account-contributions";
import { sidebarGoalActive, observeSidebarThreadGoals, sidebarGoalSignature, type SidebarGoalSource } from "./sidebar-thread-goals";


import { ActiveWebWorkbenchApplicationSupervisor, AppServerHostCatalog, retryQuery } from './workbench-application-services';
import { useHostThreadCatalogQueries } from "./use-host-thread-catalog-queries";
import { cacheThreadCatalog, mergeCachedCatalogRows, threadCatalogDisplayRows, threadCatalogResource, useClientResourceSnapshots } from "./thread-catalog-cache";

export * from "./workbench-application-services";
const subscribeNoManagedCatalog = () => () => {};

interface AppServerApplicationContextValue extends AppServerHostCatalog {
  readonly managedHostCatalog: ManagedHostCatalogSource | null;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly blobs: BlobResourceService;
  readonly images: ImageProcessingService;
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly conversationBindings: ConversationBindingStore;
  readonly extensionSettings: ExtensionSettingsStore;
  readonly extensionContributions: ExtensionContributionStore;
  readonly announcements: AnnouncementCenter;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly platformAccounts: PlatformAccountContributionRegistry;
  readonly applicationBranding: ApplicationBrandingRegistry;
  readonly threadBadges: ThreadBadgeContributionRegistry;
  readonly threadListGrouping: ThreadListGroupingContributionRegistry;
  readonly identityAvatars: IdentityAvatarContributionRegistry;
  readonly imageEditors?: import("./image-editor-contributions").ImageEditorContributionRegistry;
}

interface ConversationViewRuntimeContextValue {
  readonly runtime: AppServerWorkbenchRuntime;
  readonly activeThreadLease: AppServerThreadRuntimeLease | null;
  readonly composerController: ComposerController;
  readonly scopeId: ConversationScopeId;
  readonly viewId: string;
  readonly activationPhase: "idle" | "resolving" | "ready" | "error";
  readonly activationError: Error | null;
}

const hotApplicationContext = import.meta.hot?.data.applicationRuntimeContext as
  | Context<AppServerApplicationContextValue | null>
  | undefined;
const ApplicationRuntimeContext = hotApplicationContext
  ?? createContext<AppServerApplicationContextValue | null>(null);
const hotConversationViewContext = import.meta.hot?.data.conversationViewRuntimeContext as
  | Context<ConversationViewRuntimeContextValue | null>
  | undefined;
const ConversationViewRuntimeContext = hotConversationViewContext
  ?? createContext<ConversationViewRuntimeContextValue | null>(null);
if (import.meta.hot !== undefined) {
  import.meta.hot.data.applicationRuntimeContext = ApplicationRuntimeContext;
  import.meta.hot.data.conversationViewRuntimeContext = ConversationViewRuntimeContext;
}

export function AppServerRuntimeProvider({
  supervisor,
  children,
}: {
  readonly supervisor: ActiveWebWorkbenchApplicationSupervisor;
  readonly children: ReactNode;
}) {
  const {
    registry,
    coordinator,
    conversationBindings,
    conversationScopes,
    conversationActivation,
    conversationViews,
    navigation,
    queryClient,
    routeCheckpoints,
    commands,
    hostProfiles,
    extensionSettings,
    extensionManager,
    extensions,
    platformViewRenderers,
    platformAccounts,
    applicationBranding,
    threadBadges,
    threadListGrouping,
    identityAvatars,
    composerActionRenderers,
    imageEditors,
    botDirectory,
    sidebarLayout,
  } = supervisor;
  const registrySnapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const coordinatorSnapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const hostProfileSnapshot = useSyncExternalStore(
    hostProfiles.subscribe,
    hostProfiles.getSnapshot,
    hostProfiles.getSnapshot,
  );
  const connectionProviderSnapshot = useSyncExternalStore(
    supervisor.connectionProviders.providers.subscribe,
    supervisor.connectionProviders.providers.getSnapshot,
    supervisor.connectionProviders.providers.getSnapshot,
  );
  const runtime = coordinator.getRuntime();
  const activeThreadLease = coordinator.getActiveThreadLease();
  const returnProbe = useRef(createConversationReturnProbe()).current;
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "hidden" || coordinator.getRuntime().getSnapshot().phase !== "ready") return;
      const lease = coordinator.getActiveThreadLease();
      if (lease) void lease.retryRestore().catch(() => undefined);
    };
    const visibility = () => {
      coordinator.getActiveThreadLease()?.setRecoveryVisibility(document.visibilityState !== "hidden");
      if (document.visibilityState === "hidden") returnProbe.background(Date.now());
      else if (returnProbe.foreground(Date.now())) revalidate();
    };
    const offline = () => returnProbe.offline();
    const online = () => { if (returnProbe.online(Date.now())) revalidate(); };
    activeThreadLease?.setRecoveryVisibility(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [coordinator, returnProbe, activeThreadLease]);
  const activeConversationScopeId = conversationActivation.scopeIdFor(coordinatorSnapshot.location);
  const activeConversationViewId = coordinatorSnapshot.viewId;
  if (activeConversationViewId === null) throw new Error("Active Conversation View has no identity");
  const conversationView = conversationViews.get(activeConversationViewId);
  if (conversationView === null || conversationView.scopeId !== activeConversationScopeId) {
    throw new Error(`Conversation View ${activeConversationViewId} is unavailable`);
  }
  const composerController = conversationView.composer;
  const threadManagement = useMemo<AppServerHostCatalog["threadManagement"]>(() => {
    const manager = async (hostId: string, operation: "rename" | "archive" | "delete" | "fork" | "pin", threadId?: string) => {
      // A stale menu/dialog cannot reconnect an offline Host to mutate it.
      const host = registry.peekRuntime(hostId);
      if (!host || host.getSnapshot().phase !== "ready") throw new Error("服务器暂时不可用，请连接恢复后重试。");
      if (!host.resources.threads.capabilities?.(threadId)[operation]) throw new Error("此宿主未接通该会话操作");
      return host.resources.threads;
    };
    return {
      capabilities: (hostId, threadId) => registry.peekRuntime(hostId)?.resources.threads.capabilities?.(threadId) ?? { rename: false, archive: false, delete: false, fork: false },
      rename: async (hostId, id, name) => { const port = await manager(hostId, "rename", id); await port.rename!(id, name); },
      setPinned: async (hostId, id, pinned) => { const port = await manager(hostId, "pin", id); await port.setPinned!(id, pinned); },
      delete: async (hostId, id) => { const port = await manager(hostId, "delete", id); await port.delete!(id); },
      archive: async (hostId, id) => { const port = await manager(hostId, "archive", id); await port.archive!(id); },
      unarchive: async (hostId, id) => { const port = await manager(hostId, "archive", id); await port.unarchive!(id); },
      fork: async (hostId, id, lastTurnId) => { const port = await manager(hostId, "fork", id); return (await port.fork!({ threadId: id, excludeTurns: true, ...(lastTurnId === undefined ? {} : { lastTurnId }) })).id; },
      listArchived: async hostId => {
        const port = await manager(hostId, "archive");
        const all: Array<{ id: string; name?: string | null; preview?: string }> = [];
        let cursor: string | null = null;
        do { const page = await port.list({ archived: true, cursor, limit: 100 });
          for (const value of page.data) {
            const thread = value as { id?: unknown; name?: string | null; preview?: string };
            if (typeof thread.id !== "string") throw new Error("Invalid archived thread identity");
            all.push({ id: thread.id, name: thread.name, preview: thread.preview });
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        return all;
      },
    };
  }, [registry]);
  const applicationContextValue = useMemo<AppServerApplicationContextValue>(() => ({
    setConversationPresentationActive: supervisor.setConversationPresentationActive,
    tasks: supervisor.tasks,
    threadAttention: supervisor.threadAttention,
    clientResources: supervisor.clientResources,
    managedHostCatalog: supervisor.managedHostCatalog,
    hostProfiles,
    displayContinuity: supervisor.displayContinuity,
    agentRuntimes: supervisor.agentRuntimes,
    threadManagement,
    environmentDirectory: supervisor.environmentDirectory,
    authenticationFlows: supervisor.authenticationFlows,
    connectors: supervisor.connectors,
    connectorManager: supervisor.connectorManager,
    connectorApprovals: supervisor.connectorApprovals,
    blobs: supervisor.blobs,
    images: supervisor.images,
    conversationScopes,
    conversationBindings,
    extensionSettings,
    extensionManager,
    extensionContributions: extensions.contributions,
    extensionRuntime: extensions,
    announcements: extensions.announcements,
    platformViewRenderers,
    platformAccounts,
    applicationBranding,
    threadBadges,
    threadListGrouping,
    identityAvatars,
    composerActionRenderers,
    imageEditors,
    botDirectory,
    sidebarLayout,
    registry,
    navigation,
    routeCheckpoints,
    retargetDraft: commands.retargetDraft,
    selectedHostId: coordinatorSnapshot.selectedHostId,
    pendingLocation: coordinatorSnapshot.pendingLocation,
    currentLocation: coordinatorSnapshot.location,
    hosts: registrySnapshot.hosts,
    profiles: hostProfileSnapshot.profiles,
    connectionProviders: connectionProviderSnapshot.providers,
    selectHost: commands.selectHost,
    navigate: commands.navigate,
    selectConversation: commands.selectConversation,
    navigateToHome: commands.navigateToHome,
    promoteDraft: commands.promoteDraft,
    submit: commands.submit,
    createGoal: commands.createGoal,
    provisionHost: commands.provisionHost,
    addWebSocketHost: commands.addWebSocketHost,
    removeHost: commands.removeHost,
  }), [
    supervisor.managedHostCatalog,
    hostProfiles,
    supervisor.blobs,
    supervisor.images,
    conversationBindings,
    extensionSettings,
    extensionManager,
    registry,
    coordinatorSnapshot.pendingLocation,
    coordinatorSnapshot.location,
    coordinatorSnapshot.selectedHostId,
    conversationScopes,
    commands,
    registrySnapshot.hosts,
    hostProfileSnapshot.profiles,
    connectionProviderSnapshot.providers,
    navigation,
    threadManagement,
  ]);
  const viewContextValue = useMemo<ConversationViewRuntimeContextValue>(() => ({
    runtime,
    activeThreadLease,
    composerController,
    scopeId: activeConversationScopeId,
    viewId: activeConversationViewId,
    activationPhase: coordinatorSnapshot.phase,
    activationError: coordinatorSnapshot.error,
  }), [
    coordinatorSnapshot.error,
    coordinatorSnapshot.phase,
    activeConversationScopeId,
    activeConversationViewId,
    activeThreadLease,
    composerController,
    runtime,
  ]);

  return (
    <QueryClientProvider client={queryClient}>
      <ApplicationRuntimeContext.Provider value={applicationContextValue}>
        <ConversationViewRuntimeContext.Provider value={viewContextValue}>
          <TurnNotificationsProvider source={supervisor.turnCompletions} notifications={supervisor.turnNotifications} openConversation={commands.selectConversation}>
            {children}
          </TurnNotificationsProvider>
        </ConversationViewRuntimeContext.Provider>
      </ApplicationRuntimeContext.Provider>
    </QueryClientProvider>
  );
}

export function useBlobResources(): BlobResourceService {
  const context = useContext(ApplicationRuntimeContext);
  if (!context) throw new Error("Blob resources require the application provider");
  return context.blobs;
}

export function useImageProcessing(): ImageProcessingService {
  const context = useContext(ApplicationRuntimeContext);
  if (context === null) throw new Error("AppServer runtime is unavailable");
  return context.images;
}

export function useAppServerRuntime(): AppServerWorkbenchRuntime {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.runtime;
}

export function useActiveAppServerThread(): AppServerThreadRuntimeLease | null {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.activeThreadLease;
}

export function useAppServerHosts(): AppServerHostCatalog {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value;
}

/** The private application context captures connection authority for UI intents. */
export function useThreadPinWriter(): ThreadPinWriter {
  const application = useContext(ApplicationRuntimeContext);
  const queryClient = useQueryClient();
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  return useMemo(() => new ThreadPinWriter(queryClient, {
    capture: key => {
      const owner = application.registry.peekRuntime(key.hostId);
      const generation = owner?.getSnapshot().connectionGeneration;
      const profile = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === key.hostId);
      const authorizationEpoch = () => profile?.hostKind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() : null;
      const epoch = authorizationEpoch();
      return () => owner !== null && application.registry.peekRuntime(key.hostId) === owner
        && owner.getSnapshot().phase === "ready" && owner.getSnapshot().connectionGeneration === generation
        && application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === key.hostId)?.revision === profile?.revision
        && authorizationEpoch() === epoch;
    },
    persist: (key, pinned) => application.threadManagement.setPinned(key.hostId, key.threadId, pinned),
  }), [application.registry, application.hostProfiles, application.managedHostCatalog, application.threadManagement, queryClient]);
}

/** Observe one Host, independently of the currently presented conversation. */
export function useHostConnectionPhase(hostId: string) {
  const application = useContext(ApplicationRuntimeContext);
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  const registry = application.registry;
  return useSyncExternalStore(
    (listener) => {
      let runtime = registry.peekRuntime(hostId);
      let unsubscribe = runtime?.subscribe(listener);
      const removeRegistry = registry.subscribe(() => {
        const next = registry.peekRuntime(hostId);
        if (next !== runtime) {
          unsubscribe?.();
          runtime = next;
          unsubscribe = runtime?.subscribe(listener);
        }
        listener();
      });
      return () => { removeRegistry(); unsubscribe?.(); };
    },
    () => registry.peekRuntime(hostId)?.getSnapshot().phase ?? "idle",
    () => "idle",
  );
}

export function useConversationScopeRegistry(): ConversationScopeRegistry {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value.conversationScopes;
}

export function useConversationScopeRegistrySnapshot(): ConversationScopeRegistrySnapshot {
  const session = useConversationScopeRegistry();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useRootComposerController(): ComposerController {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.composerController;
}

export function useConversationViewIdentity(): {
  readonly scopeId: ConversationScopeId;
  readonly viewId: string;
} {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return useMemo(() => ({ scopeId: value.scopeId, viewId: value.viewId }), [
    value.scopeId,
    value.viewId,
  ]);
}

/** Local display identity; acquiring this binding does not acquire a Thread lease. */
export function useConversationViewDisplayKey() {
  const application = useContext(ApplicationRuntimeContext);
  const view = useContext(ConversationViewRuntimeContext);
  if (application === null || view === null) throw new Error("ConversationViewRuntimeProvider is missing");
  const bindings = useSyncExternalStore(
    application.conversationBindings.subscribe,
    application.conversationBindings.getSnapshot,
    application.conversationBindings.getSnapshot,
  );
  return bindings.bindings.find(binding => binding.scopeId === view.scopeId)?.conversationKey ?? null;
}

export function useConversationViewActivation(): {
  readonly phase: "idle" | "resolving" | "ready" | "error";
  readonly error: Error | null;
} {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return useMemo(() => ({
    phase: value.activationPhase,
    error: value.activationError,
  }), [value.activationError, value.activationPhase]);
}

/** Host-only consumers must not subscribe to the active transcript. */
export function useAppServerHostSnapshot() {
  const runtime = useAppServerRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

export function useAppServerSnapshot(): AppServerWorkbenchViewSnapshot {
  const activeThreadLease = useActiveAppServerThread();
  const hostSnapshot = useAppServerHostSnapshot();
  const getConversationSnapshot = activeThreadLease === null
    ? () => null
    : activeThreadLease.getSnapshot;
  const subscribeConversation = activeThreadLease === null
    ? (_listener: () => void) => () => undefined
    : activeThreadLease.subscribe;
  const conversation = useSyncExternalStore(
    subscribeConversation,
    getConversationSnapshot,
    getConversationSnapshot,
  );
  return useMemo(() => ({
    ...hostSnapshot,
    activeThreadId: activeThreadLease?.threadId ?? null,
    conversation,
  }), [activeThreadLease?.threadId, conversation, hostSnapshot]);
}

export function useThreadCatalog(): {
  readonly protocolThreads: readonly Thread[];
  readonly threads: readonly WorkbenchThread[];
  readonly hasNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
} {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerHostSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "threads", "updated_at", "desc", false] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.threads.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const protocolThreads = useMemo(
    () => mergeThreadCatalogPages(query.data?.pages ?? []),
    [query.data],
  );
  const threads = useMemo(() => protocolThreads.map((thread) => projectAppServerThread(thread)), [protocolThreads]);
  return {
    protocolThreads,
    threads,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
  };
}

export interface MultiHostWorkbenchThread extends WorkbenchThread {
  readonly schedule?: ConversationScheduleSummary;
  readonly goalActive?: boolean;
  readonly interactionAvailable: boolean;
  /** Current transport route. Not the stable Server identity. */
  readonly connectionHostId: string;
  readonly connectionHostLabel: string;
  readonly serverOrigin: ThreadServerOrigin;
  readonly serverRouteLocality: ServerRouteLocality;
}

/**
 * Application-level sidebar projection. Each Host owns its query and failure;
 * merging happens only after host provenance has been attached.
 */
export function useMultiHostThreadCatalog(): {
  readonly scheduleCatalogs: readonly HostScheduleCatalog[];
  readonly threads: readonly MultiHostWorkbenchThread[];
  readonly searchSources: readonly ConversationSearchSource[];
  readonly isFetching: boolean;
  readonly catalogs: readonly HostThreadCatalogState[];
  readonly retry: (hostId: string) => Promise<void>;
  readonly discovery: "loading" | "error" | null;
  readonly retryDiscovery: () => Promise<void>;
} {
  const application = useContext(ApplicationRuntimeContext);
  const [, setReadinessRevision] = useState(0);
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  const attentionRevision = useSyncExternalStore(application.threadAttention.subscribe,
    application.threadAttention.getSnapshot, application.threadAttention.getSnapshot);
  const readManagementSignature = useCallback(
    () => managedHostCatalogSignature(application.managedHostCatalog),
    [application.managedHostCatalog],
  );
  useSyncExternalStore(
    application.managedHostCatalog?.subscribe ?? subscribeNoManagedCatalog,
    readManagementSignature,
    readManagementSignature,
  );
  const management = application.managedHostCatalog?.getSnapshot() ?? null;
  const visibleHostIds = useMemo(() => new Set(
    application.profiles
      .filter((profile) => profile.enabled && profile.includeInSidebar)
      .map((profile) => profile.hostId),
  ), [application.profiles]);
  const hosts = useMemo(
    () => application.hosts.filter((host) => visibleHostIds.has(host.hostId)),
    [application.hosts, visibleHostIds],
  );
  const queryClient = useQueryClient();
  const hostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  const resourceScope = useSyncExternalStore(application.clientResources.subscribe, application.clientResources.getSnapshot);
  const resourceProfiles = JSON.stringify(hosts.map(host => [host.hostId,
    application.profiles.find(profile => profile.hostId === host.hostId)!.revision]));
  const catalogResources = useMemo(() => hosts.map(host => application.clientResources.remote(threadCatalogResource,
    JSON.stringify([host.hostId, application.profiles.find(profile => profile.hostId === host.hostId)!.revision]))),
  [application.clientResources, resourceScope, resourceProfiles]);
  const savedCatalogs = useClientResourceSnapshots(catalogResources);
  // A credential boundary can precede the old socket's teardown. Require a new
  // ready incarnation before reading/caching through that socket for a new scope.
  const catalogScopeFence = useRef({ epoch: resourceScope,
    previous: new Map<string, { runtime: unknown; generation: number | undefined }>() });
  if (catalogScopeFence.current.epoch !== resourceScope) {
    catalogScopeFence.current = { epoch: resourceScope, previous: new Map(hosts.map(host => {
      const runtime = application.registry.peekRuntime(host.hostId);
      return [host.hostId, { runtime, generation: runtime?.getSnapshot().connectionGeneration }];
    })) };
  }
  useEffect(() => subscribeHostCatalogReadiness(
    application.registry,
    hostIds,
    hostId => {
      setReadinessRevision(value => value + 1);
      if (application.registry.peekRuntime(hostId)?.getSnapshot().phase === "ready") {
        void queryClient.invalidateQueries({ queryKey: ["appserver", hostId, "threads"] });
      }
    },
  ), [application.registry, hostIds, queryClient]);
  const phases = hosts.map(host => application.registry.peekRuntime(host.hostId)?.getSnapshot().phase);
  const admitted = hosts.map((host, index) => {
    const previous = catalogScopeFence.current.previous.get(host.hostId);
    const runtime = application.registry.peekRuntime(host.hostId);
    return (!previous || runtime !== previous.runtime || runtime?.getSnapshot().connectionGeneration !== previous.generation)
      && canReadHostThreadCatalog(application.profiles.find(profile => profile.hostId === host.hostId)!, phases[index], management);
  });
  const queries = useHostThreadCatalogQueries(
    hosts.map((host, index) => ({
      // Discovery may attach a reader to an explicitly connected managed
      // Server, but cannot dial an idle remote merely to paint Chat.
      enabled: admitted[index],
      queryKey: sidebarThreadCatalogQueryKey(host.hostId, {
        clientEpoch: resourceScope,
        revision: application.profiles.find(profile => profile.hostId === host.hostId)!.revision,
        authorizationEpoch: host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null,
      }),
      profile: application.profiles.find(profile => profile.hostId === host.hostId)!,
      currentProfile: () => application.hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === host.hostId),
      management: application.managedHostCatalog,
      registry: application.registry,
    })),
  );
  // One projection per admitted Host, independent of visible rows and selected conversation.
  const scheduleKeys = hosts.map(host => [...sidebarThreadCatalogQueryKey(host.hostId, {
    clientEpoch: resourceScope,
    revision: application.profiles.find(profile => profile.hostId === host.hostId)!.revision,
    authorizationEpoch: host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null,
  }), "schedule-summary"]);
  const scheduleQueries = useQueries({ queries: hosts.map((host, index) => {
    const runtime = application.registry.peekRuntime(host.hostId);
    const profile = application.profiles.find(value => value.hostId === host.hostId)!;
    const epoch = application.managedHostCatalog?.getAuthorizationEpoch();
    const current = () => application.registry.peekRuntime(host.hostId) === runtime
      && application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId)?.revision === profile.revision
      && (host.kind !== "remote-ssh" || epoch === application.managedHostCatalog?.getAuthorizationEpoch())
      && canReadHostThreadCatalog(profile, runtime?.getSnapshot().phase, application.managedHostCatalog?.getSnapshot() ?? null);
    const capability = runtime?.resources.host.getInitializeResult()?.capabilities?.extensions?.["opencraft/conversation-schedules"] as { summary?: unknown } | undefined;
    return {
      queryKey: scheduleKeys[index]!,
      enabled: admitted[index] && phases[index] === "ready"
        && capability?.summary === true
        && runtime?.resources.host.canRequest?.("opencraft/schedules/list") === true,
      queryFn: async () => {
        if (!runtime || !current()) throw new Error("Schedule catalog scope changed");
        const result = await runtime.resources.protocol.request("opencraft/schedules/list", {});
        if (!current()) throw new Error("Schedule catalog scope changed");
        // A durable conversation without a first Turn can be absent from thread/list.
        // Read its native metadata here; the catalog remains the only UI reader.
        const known = new Set((queries[index]?.data?.data ?? []).map(thread => thread.id));
        const missing = result.schedules.filter(plan => !known.has(plan.threadId));
        const titleByThreadId: Record<string, string> = {};
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (cursor < missing.length) {
            const plan = missing[cursor++]!;
            if (!current()) throw new Error("Schedule catalog scope changed");
            try {
              const { thread } = await runtime.resources.protocol.request("thread/read", { threadId: plan.threadId, includeTurns: false });
              if (!current()) throw new Error("Schedule catalog scope changed");
              if (thread.name?.trim()) titleByThreadId[plan.threadId] = thread.name;
            } catch {
              if (!current()) throw new Error("Schedule catalog scope changed");
              // Missing/deleted native metadata must not hide the remaining plans.
            }
          }
        }));
        return { ...result, titleByThreadId };
      },
      staleTime: 30_000, refetchInterval: 60_000, retry: false,
    };
  }) });
  const scheduleScope = JSON.stringify(scheduleKeys);
  useEffect(() => {
    const remove = hosts.flatMap((host, index) => {
      if (!admitted[index] || phases[index] !== "ready") return [];
      const runtime = application.registry.peekRuntime(host.hostId);
      const unsubscribe = runtime?.resources.host.subscribeSchedulesChanged?.(() => {
        void queryClient.invalidateQueries({ queryKey: scheduleKeys[index]!, exact: true });
      });
      // Catch up on every ready incarnation, including notifications missed offline.
      void queryClient.invalidateQueries({ queryKey: scheduleKeys[index]!, exact: true });
      return unsubscribe ? [unsubscribe] : [];
    });
    return () => { for (const unsubscribe of remove) unsubscribe(); };
  }, [application.registry, hosts, scheduleScope, phases.join("|"), admitted.join("|"), queryClient]);
  const scheduleSignature = scheduleQueries.map(query => query.dataUpdatedAt).join("|");
  const displayable = hosts.map(host => canDisplayHostThreadCatalog(
    application.profiles.find(profile => profile.hostId === host.hostId)!, management,
  ));
  const querySignature = queries.map((query, index) => `${displayable[index]}:${admitted[index]}:${phases[index]}:${query.dataRevision}:${query.hasNextPage}:${query.status}:${query.fetchStatus}`).join("|");
  const persistedCatalogObservations = useRef(new WeakMap<object, unknown>());
  useEffect(() => {
    queries.forEach((query, index) => {
      if (!displayable[index] || !admitted[index] || !query.data || query.isError) return;
      const resource = catalogResources[index]!;
      if (persistedCatalogObservations.current.get(resource) === query.data) return;
      persistedCatalogObservations.current.set(resource, query.data);
      const host = hosts[index]!;
      const profile = application.profiles.find(value => value.hostId === host.hostId)!;
      const runtime = application.registry.peekRuntime(host.hostId);
      const connectionGeneration = runtime?.getSnapshot().connectionGeneration;
      const authorizationEpoch = host.kind === "remote-ssh"
        ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null;
      const fence = { isCurrent: () => {
        const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
        const currentRuntime = application.registry.peekRuntime(host.hostId);
        return application.clientResources.getSnapshot() === resourceScope
          && current?.revision === profile.revision
          && currentRuntime === runtime
          && currentRuntime?.getSnapshot().connectionGeneration === connectionGeneration
          && (host.kind !== "remote-ssh" || application.managedHostCatalog?.getAuthorizationEpoch() === authorizationEpoch)
          && canReadHostThreadCatalog(current, currentRuntime?.getSnapshot().phase,
            application.managedHostCatalog?.getSnapshot() ?? null);
      } };
      // A first successful page is useful immediately, but is not a complete directory.
      void catalogResources[index]!.observe(cacheThreadCatalog(mergeCachedCatalogRows(
        query.data.data.map(thread => projectAppServerThread(thread)),
        catalogResources[index]!.getSnapshot().value, !query.hasNextPage), !query.hasNextPage), fence).catch(() => undefined);
    });
  }, [catalogResources, querySignature]);
  const goalSources = useMemo(() => hosts.flatMap((host, index): SidebarGoalSource[] => {
    const profile = application.profiles.find(value => value.hostId === host.hostId)!;
    const runtime = application.registry.peekRuntime(host.hostId);
    if (!runtime || !admitted[index] || !displayable[index] || phases[index] !== "ready" || queries[index]?.hasNextPage) return [];
    const epoch = profile.hostKind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() : undefined;
    return [{
      goals: runtime.resources.goals,
      threadIds: (queries[index]?.data?.data ?? []).map(thread => thread.id),
      isCurrent: () => {
        const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
        return current?.revision === profile.revision
          && application.registry.peekRuntime(host.hostId) === runtime
          && runtime.getSnapshot().phase === "ready"
          && (profile.hostKind !== "remote-ssh" || epoch === application.managedHostCatalog?.getAuthorizationEpoch())
          && canReadHostThreadCatalog(current, "ready", application.managedHostCatalog?.getSnapshot() ?? null);
      },
    }];
  }), [application, hosts, querySignature]);
  const subscribeGoals = useCallback((listener: () => void) => {
    const remove = goalSources.map(source => observeSidebarThreadGoals(source, listener));
    return () => { for (const unsubscribe of remove) unsubscribe(); };
  }, [goalSources]);
  const readGoals = useCallback(() => sidebarGoalSignature(goalSources), [goalSources]);
  const goalRevision = useSyncExternalStore(subscribeGoals, readGoals, readGoals);
  useEffect(() => {
    const scope = application.threadAttention.getScope();
    for (const [index, host] of hosts.entries()) {
      if (!admitted[index] || !displayable[index] || queries[index]?.hasNextPage) continue;
      const profile = application.profiles.find(value => value.hostId === host.hostId)!;
      void application.threadAttention.catchUp(profile, queries[index]?.data?.data ?? [], () => {
        const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
        return scope === application.threadAttention.getScope() && current?.revision === profile.revision
          && canReadHostThreadCatalog(current, application.registry.peekRuntime(host.hostId)?.getSnapshot().phase,
            application.managedHostCatalog?.getSnapshot() ?? null);
      });
    }
  }, [hosts, querySignature, attentionRevision]);
  const threads = useMemo(() => hosts.flatMap((host, index) =>
    (displayable[index] ? threadCatalogDisplayRows(queries[index]?.data?.data.map(thread => projectAppServerThread(thread)),
      savedCatalogs[index]?.value ?? null, !queries[index]!.hasNextPage) : []).map(({ thread, confirmed }) => {
      const server = legacyDirectServerProjectionFromHost({
        hostId: host.hostId,
        hostKind: host.kind,
        label: host.label,
      });
      return {
        ...thread,
        schedule: scheduleQueries[index]?.data?.schedules.find(plan => plan.threadId === thread.id),
        goalActive: goalSources.some(source => source.goals === application.registry.peekRuntime(host.hostId)?.resources.goals
          && source.isCurrent() && source.goals.capability(thread.id)?.read
          && sidebarGoalActive(source.goals.getSnapshot(thread.id).goal)),
        unread: application.threadAttention.unread(host.hostId, thread.id),
        connectionHostId: host.hostId,
        interactionAvailable: phases[index] === "ready" && admitted[index] && confirmed,
        connectionHostLabel: host.label,
        ...server,
      };
    })).sort((left, right) => right.updatedAt - left.updatedAt), [hosts, querySignature, savedCatalogs, attentionRevision, goalSources, goalRevision, scheduleSignature]);
  const searchScope = JSON.stringify(hosts.map((host, index) => [host.hostId,
    application.profiles.find(profile => profile.hostId === host.hostId)?.revision,
    host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() : null,
    application.registry.peekRuntime(host.hostId)?.getSnapshot().connectionGeneration, phases[index], admitted[index], displayable[index]]));
  const conversationSources = useMemo(() => hosts.map(host => {
    const profile = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId)!;
    const runtime = application.registry.peekRuntime(host.hostId);
    const epoch = host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() : null;
    const generation = runtime?.getSnapshot().connectionGeneration;
    const available = canReadHostThreadCatalog(profile, runtime?.getSnapshot().phase, application.managedHostCatalog?.getSnapshot() ?? null)
      && runtime?.getSnapshot().phase === "ready";
    // Admission is not upstream feature discovery. Legacy/native Servers may
    // omit a manifest and identify their userAgent with the first client's name;
    // let the authoritative RPC reject unsupported searches with -32601.
    const supported = runtime?.resources.host.canRequest?.("thread/search") !== false;
    const assertCurrent = () => {
      const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
      if (!current || current.revision !== profile.revision || application.registry.peekRuntime(host.hostId) !== runtime
        || runtime?.getSnapshot().connectionGeneration !== generation
        || (host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() : null) !== epoch
        || !canReadHostThreadCatalog(current, runtime?.getSnapshot().phase, application.managedHostCatalog?.getSnapshot() ?? null)) {
        throw new Error("Conversation search scope changed");
      }
    };
    const protocol: import("@opencraft/workbench-runtime").AppServerProtocolResourcePort = {
      request: (method, params, options) => runtime!.resources.protocol.request(method, params, options),
    };
    const scope = {
      key: JSON.stringify([host.hostId, profile.revision, epoch, generation, available]),
      hostId: host.hostId, available, assertCurrent,
      protocol,
    };
    return { search: createAppServerContentSearchSource({
      ...scope, label: host.label, supported,
      project: thread => ({ ...projectAppServerThread(thread),
        ...legacyDirectServerProjectionFromHost({ hostId: host.hostId, hostKind: host.kind, label: host.label }),
        connectionHostId: host.hostId, interactionAvailable: true }),
    }) };
  }), [application, hosts, searchScope]);
  const searchSources = useMemo(() => conversationSources.map(source => source.search), [conversationSources]);
  const catalogs = useMemo(() => hosts.map((host, index) => ({
      hostId: host.hostId,
      label: host.label,
      phase: threadCatalogPhase({ admitted: admitted[index]!, status: queries[index]!.status, isFetching: queries[index]!.isFetching, partial: queries[index]!.hasNextPage }),
      ...(queries[index]!.hasNextPage ? { partial: true } : {}),
      ...(displayable[index] && catalogCachedAt(queries[index]!.data) !== undefined ? { cachedAt: catalogCachedAt(queries[index]!.data) }
        : displayable[index] && queries[index]!.data === undefined && savedCatalogs[index]?.value
          ? { cachedAt: savedCatalogs[index]!.savedAt ?? undefined } : {}),
    })),
    [hosts, querySignature, savedCatalogs]);
  return {
    scheduleCatalogs: hosts.flatMap((host, index): HostScheduleCatalog[] => {
      const query = scheduleQueries[index]!;
      const runtime = application.registry.peekRuntime(host.hostId);
      const capability = runtime?.resources.host.getInitializeResult()?.capabilities?.extensions?.["opencraft/conversation-schedules"] as { summary?: unknown; calendar?: unknown } | undefined;
      const readable = admitted[index] && phases[index] === "ready";
      // An idle connection recipe is not evidence of a scheduling Server.
      // Keep previously confirmed catalogs visible when their Host disconnects.
      if (!readable && capability?.summary !== true && query.data === undefined) return [];
      const profile = application.profiles.find(value => value.hostId === host.hostId)!;
      const epoch = application.managedHostCatalog?.getAuthorizationEpoch();
      const assertScope = () => {
        const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
        if (!runtime || application.registry.peekRuntime(host.hostId) !== runtime || current?.revision !== profile.revision
          || (host.kind === "remote-ssh" && epoch !== application.managedHostCatalog?.getAuthorizationEpoch())
          || !canReadHostThreadCatalog(current, runtime.getSnapshot().phase, application.managedHostCatalog?.getSnapshot() ?? null)
          || runtime.getSnapshot().phase !== "ready") throw new Error("Schedule catalog scope changed");
      };
      const port: ConversationSchedulesRequestPort | null = readable && runtime?.resources.host.canRequest?.("opencraft/schedules/read") === true ? {
        request: async (method, params) => {
          const current = application.hostProfiles.getSnapshot().profiles.find(value => value.hostId === host.hostId);
          if (!runtime || application.registry.peekRuntime(host.hostId) !== runtime || current?.revision !== profile.revision
            || (host.kind === "remote-ssh" && epoch !== application.managedHostCatalog?.getAuthorizationEpoch())
            || !canReadHostThreadCatalog(current, runtime.getSnapshot().phase, application.managedHostCatalog?.getSnapshot() ?? null)
            || runtime.getSnapshot().phase !== "ready" || runtime.resources.host.canRequest?.(method) !== true) throw new Error("Schedule catalog scope changed");
          return runtime.resources.protocol.request(method, params);
        },
      } : null;
      return [{
        hostId: host.hostId, hostLabel: host.label, scope: JSON.stringify(scheduleKeys[index]),
        schedules: displayable[index] ? query.data?.schedules ?? [] : [],
        titleByThreadId: displayable[index] ? query.data?.titleByThreadId ?? {} : {},
        phase: !readable ? "offline" : capability?.summary !== true || runtime?.resources.host.canRequest?.("opencraft/schedules/list") !== true ? "unsupported" : query.isError ? "error" : query.isPending ? "loading" : "ready",
        cached: displayable[index] && query.data !== undefined, port,
        ...(port && runtime?.resources.host.canRequest?.("thread/start") === true ? { creation: {
          calendar: capability?.calendar === true,
          options: async () => {
            assertScope();
            const permissions = await runtime.resources.composerCatalog.listPermissionProfiles({ limit: 100, cursor: null });
            const skills = runtime.resources.host.canRequest?.("skills/list") === true
              ? await runtime.resources.protocol.request("skills/list", {}) : { data: [] };
            assertScope();
            return { permissions: permissions.data, skills: [...new Map(skills.data.flatMap(entry => entry.skills.filter(skill => skill.enabled).map(skill => [skill.name, { name: skill.name, description: skill.description }] as const))).values()] };
          },
          createConversation: async () => {
            assertScope();
            const result = await runtime.resources.protocol.request("thread/start", { ephemeral: false });
            // Return an acknowledged identity even if admission was revoked during the request.
            return result.thread.id;
          },
          nameConversation: async (threadId: string, name: string) => {
            assertScope();
            await runtime.resources.protocol.request("thread/name/set", { threadId, name });
          },
        } } : {}),
        retry: async () => { if (readable && capability?.summary === true && runtime?.resources.host.canRequest?.("opencraft/schedules/list") === true) await query.refetch(); },
      }];
    }),
    threads,
    searchSources,
    discovery: managedCatalogDiscoveryPhase(management),
    retryDiscovery: () => application.managedHostCatalog?.refresh() ?? Promise.resolve(),
    isFetching: queries.some((query) => query.isFetching),
    catalogs,
    retry: async hostId => {
      // A view may retry its reader, never establish an idle SSH connection
      // or change the selected execution target. Recheck live admission.
      const profile = application.hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === hostId);
      const currentManagement = application.managedHostCatalog?.getSnapshot() ?? management;
      if (!profile || !canReadHostThreadCatalog(profile, application.registry.peekRuntime(hostId)?.getSnapshot().phase, currentManagement)) return;
      await queryClient.refetchQueries({ queryKey: sidebarThreadCatalogQueryKey(hostId, {
        clientEpoch: resourceScope,
        revision: profile.revision,
        authorizationEpoch: profile.hostKind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null,
      }), exact: true, type: "active" }, { cancelRefetch: false });
    },
  };
}

export interface ProjectCatalogSnapshot {
  readonly projects: readonly Project[];
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * Projects are an AppServer-owned catalog. A Draft may choose one of their
 * roots, but the client never invents a host path or an execution binding.
 */
export function useProjectCatalog(): ProjectCatalogSnapshot {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerHostSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "projects"] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.projects.list({
      cursor: pageParam,
      limit: 100,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);

  return {
    projects: query.data?.pages.flatMap((page) => page.data) ?? [],
    isFetching: query.isFetching,
    error: errorOrNull(query.error),
  };
}

export interface ComposerCatalogSnapshot {
  readonly personalDefaultsPending: boolean;
  readonly models: readonly Model[];
  readonly displayModels: readonly Model[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly isFetching: boolean;
  readonly modelError: Error | null;
  readonly permissionProfileError: Error | null;
  readonly newThreadDefaults: {
    readonly model: string | null;
    readonly effort: string | null;
    readonly serviceTier?: string | null;
  } | null;
  readonly rememberModelDefaults: ((defaults: {
    readonly model: string;
    readonly effort: string | null;
    readonly serviceTier?: string | null;
  }, hostId?: string) => void) | undefined;
  readonly onModelMenuOpen: () => void;
  readonly retryModels: () => void;
}

function errorOrNull(error: unknown): Error | null {
  if (error == null) return null;
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Host-scoped AppServer catalogs consumed by Composer. These are query data,
 * not Replica entities: the server owns availability and cwd requirements,
 * while the immutable SubmitIntent records the user's concrete selection.
 */
export function useComposerCatalog(
  cwd: string | null,
  threadId: string | null = null,
  runtimeHostConfiguration = true,
): ComposerCatalogSnapshot {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerHostSnapshot();
  const application = useAppServerHosts();
  const preferences = useUiPreferencesRuntime();
  const preferenceSnapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const readAccountScope = useCallback(() => application.threadAttention.getScope() ?? "anonymous", [application.threadAttention]);
  const accountScope = useSyncExternalStore(application.threadAttention.subscribe, readAccountScope);
  const displayScope = useSyncExternalStore(application.displayContinuity.subscribe, application.displayContinuity.getScope);
  const personalDefaults = useAccountModelDefaults(application.platformAccounts, snapshot.hostId, runtimeHostConfiguration && threadId === null);
  const rememberedSelection = !runtimeHostConfiguration ? undefined : personalDefaults.authoritative ? personalDefaults.selection : readModelSelection(preferenceSnapshot.values["chat.modelSelections"],
    runtimeHostConfiguration ? { displayScope, accountScope, hostId: snapshot.hostId } : null);
  const enabled = snapshot.phase === "ready";
  const supportsScopedModelCatalog =
    runtime.resources.host.getInitializeResult()?.capabilities?.extensions?.[
      OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION
    ] !== undefined;
  const modelCatalogOwner = supportsScopedModelCatalog ? threadId : null;
  const queryClient = useQueryClient();
  const options = useMemo(() => composerCapabilitiesOptions(snapshot.hostId, modelCatalogOwner, runtime.resources.composerCatalog), [snapshot.hostId, modelCatalogOwner, runtime]);
  // Historical reading needs the persisted selection, not a model directory.
  // The existing menu-open action loads choices when the user requests them.
  const capabilities = useQuery({ ...options, enabled: enabled && threadId === null });
  const connectionGeneration = runtime.resources.host.getConnectionGeneration?.() ?? 0;
  const defaultsKey = useMemo(
    () => ["appserver", snapshot.hostId, "composer-new-thread-defaults", connectionGeneration, cwd] as const,
    [connectionGeneration, cwd, snapshot.hostId],
  );
  const defaults = useQuery({
    queryKey: defaultsKey,
    enabled: enabled && threadId === null,
    retry: false,
    queryFn: async () => {
      try {
        return {
          supported: true as const,
          ...(await runtime.resources.composerCatalog.readNewThreadDefaults(cwd)),
        };
      } catch (cause) {
        if (cause instanceof AppServerRpcError && cause.code === -32601) {
          return { supported: false as const, model: null, effort: null };
        }
        throw cause;
      }
    },
    staleTime: 60_000,
  });
  const rememberModelDefaults = useCallback((next: {
    readonly model: string;
    readonly effort: string | null;
    readonly serviceTier?: string | null;
  }, hostId: string = snapshot.hostId) => {
    if (!runtimeHostConfiguration || threadId !== null
      || readAccountScope() !== accountScope
      || application.displayContinuity.getScope() !== displayScope) return;
    if (personalDefaults.authoritative) {
      personalDefaults.remember(next, hostId);
      return;
    }
    // Standalone clients without an account authority retain installation memory.
    // Personal selections never mutate shared Host configuration.
    void rememberModelSelection(preferences, { displayScope, accountScope, hostId }, next).catch(() => undefined);
  }, [runtimeHostConfiguration, threadId, accountScope, readAccountScope, displayScope, application, preferences, snapshot.hostId, personalDefaults.authoritative, personalDefaults.remember]);
  const catalogActions = useMemo(() => ({
    onModelMenuOpen: () => {
      if (!enabled) return;
      const failed = queryClient.getQueryState(options.queryKey)?.error != null;
      void queryClient.fetchQuery({ ...options, ...(failed ? { staleTime: 0 } : {}) }).catch(() => undefined);
    },
    retryModels: () => { if (enabled) void queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined); },
  }), [enabled, options, queryClient, snapshot.hostId]);
  const permissionProfiles = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "permission-profiles", cwd] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listPermissionProfiles({
      cursor: pageParam,
      limit: 100,
      cwd,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (permissionProfiles.hasNextPage && !permissionProfiles.isFetchingNextPage) {
      void permissionProfiles.fetchNextPage();
    }
  }, [
    permissionProfiles.fetchNextPage,
    permissionProfiles.hasNextPage,
    permissionProfiles.isFetchingNextPage,
  ]);

  const permissionProfileData = useMemo(
    () => permissionProfiles.data?.pages.flatMap((page) => page.data) ?? [],
    [permissionProfiles.data],
  );

  const currentModels = capabilities.data?.metadataReader === runtime.resources.composerCatalog ? capabilities.data.models : undefined;
  const observationOwner = useMemo(() => ({finish:null as ReturnType<typeof beginObservedOperation> | null,done:false}), [snapshot.hostId,threadId,connectionGeneration]);
  useEffect(()=>{observationOwner.finish=beginObservedOperation("configuration_confirmed");return ()=>{if(!observationOwner.done)observationOwner.finish?.("aborted");};},[observationOwner]);
  useEffect(() => {
    if (!observationOwner.done && currentModels && !personalDefaults.isPending && !personalDefaults.error && !capabilities.error) {
      observationOwner.done=true;observationOwner.finish?.("ok",{count:currentModels.length});
    }
  },[observationOwner,currentModels,personalDefaults.isPending,personalDefaults.error,capabilities.error]);

  return {
    personalDefaultsPending: personalDefaults.isPending,
    models: currentModels ?? [],
    displayModels: currentModels ?? cachedComposerModelMetadata(queryClient, snapshot.hostId, runtime.resources.composerCatalog),
    permissionProfiles: permissionProfileData,
    isFetching: capabilities.isFetching || permissionProfiles.isFetching || personalDefaults.isFetching,
    modelError: personalDefaults.error ? errorOrNull(personalDefaults.error) : capabilities.error ? new Error(`${capabilities.data ? "能力目录刷新失败，当前显示上次结果" : "能力目录加载失败"}：${errorOrNull(capabilities.error)!.message}`) : null,
    permissionProfileError: errorOrNull(permissionProfiles.error),
    newThreadDefaults: rememberedSelection ? { ...rememberedSelection, serviceTier: rememberedSelection.serviceTier !== undefined ? rememberedSelection.serviceTier : defaults.data?.supported === true ? defaults.data.serviceTier : undefined } : (defaults.data?.supported === true
      ? { model: defaults.data.model, effort: defaults.data.effort, serviceTier: defaults.data.serviceTier }
      : null),
    // Historical conversation edits belong only to their existing Composer.
    rememberModelDefaults: runtimeHostConfiguration && threadId === null
      ? rememberModelDefaults
      : undefined,
    ...catalogActions,
  };
}

function targetHostId(target: ComposerTarget): string {
  return target.type === "new-thread" ? target.execution.hostId : target.key.hostId;
}

function normalizeRoots(roots: readonly string[]): readonly string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The request was aborted", "AbortError");
  const error = new Error("The request was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Skills are host/cwd query data, not Replica state. The returned
 * catalog delays `skills/list` until the user opens `$` (including an empty
 * query); file search still requires text. It shares Host/root-scoped results
 * through TanStack Query and invalidates every cached
 * root-set for this host when AppServer emits `skills/changed`.
 */
interface PendingMentionSearch {
  readonly query: string;
  readonly limit: number;
  readonly reject: (error: Error) => void;
  readonly resolve: (entries: readonly import("@opencraft/composer-core").ComposerCatalogEntry[]) => void;
  readonly removeAbortListener: () => void;
}

function fileSearchEntries(
  files: readonly import("@opencraft/appserver-protocol/generated").FuzzyFileSearchResult[],
  limit: number,
): readonly import("@opencraft/composer-core").ComposerCatalogEntry[] {
  return files.slice(0, limit).map((file) => ({
    id: `file:${file.root}:${file.path}`,
    kind: "mention" as const,
    label: file.file_name,
    detail: file.path,
    uri: file.path.startsWith("/")
      ? file.path
      : `${file.root.replace(/[\\/]+$/u, "")}/${file.path.replace(/^[\\/]+/u, "")}`,
    metadata: {
      root: file.root,
      matchType: file.match_type,
      score: file.score,
      indices: file.indices,
    },
  }));
}

/**
 * One host-scoped Composer catalog. Skills are cached query data while file
 * mentions use the Host's long-lived fuzzy-search session and therefore avoid a
 * request/session waterfall for every keystroke.
 */
export function useAppServerComposerCatalog(workspaceRoots: readonly string[]): ComposerCatalog {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerHostSnapshot();
  const queryClient = useQueryClient();
  const rootKey = JSON.stringify(normalizeRoots(workspaceRoots));
  const skillRevision = useRef(0);
  const skillListeners = useRef(new Set<() => void>());
  const enabled = snapshot.phase === "ready" || snapshot.phase === "reconnecting";
  const searchStateRef = useRef<{
    key: string;
    session: Promise<FuzzyFileSearchSession> | null;
    pending: PendingMentionSearch | null;
  }>({ key: "", session: null, pending: null });

  useEffect(() => {
    if (!enabled) return;
    return runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      // A new key prevents an in-flight pre-change response from becoming the
      // current catalog even when the underlying RPC cannot be cancelled.
      skillRevision.current++;
      void queryClient.invalidateQueries({
        queryKey: ["appserver", snapshot.hostId, "skills"],
      });
      for (const listener of [...skillListeners.current]) listener();
    });
  }, [enabled, queryClient, runtime, snapshot.hostId]);

  useEffect(() => {
    const state = searchStateRef.current;
    if (state.key === `${snapshot.hostId}:${rootKey}`) return;
    state.pending?.removeAbortListener();
    state.pending?.reject(abortError());
    state.pending = null;
    const previousSession = state.session;
    state.key = `${snapshot.hostId}:${rootKey}`;
    state.session = null;
    if (previousSession !== null) {
      void previousSession.then((session) => session.stop()).catch(() => undefined);
    }
  }, [rootKey, snapshot.hostId]);

  useEffect(() => () => {
    const state = searchStateRef.current;
    state.pending?.removeAbortListener();
    state.pending?.reject(abortError());
    state.pending = null;
    if (state.session !== null) {
      void state.session.then((session) => session.stop()).catch(() => undefined);
      state.session = null;
    }
  }, []);

  return useMemo<ComposerCatalog>(() => {
    const roots = JSON.parse(rootKey) as string[];
    const state = searchStateRef.current;
    const ensureFileSearchSession = (): Promise<FuzzyFileSearchSession> => {
      if (runtime.resources.host.canRequest?.("fuzzyFileSearch/sessionStart") === false) return Promise.reject(new Error("此连接暂不支持文件搜索"));
      if (state.session !== null) return state.session;
      state.session = runtime.resources.composerCatalog.createFuzzyFileSearchSession({
        roots,
        onUpdated(update) {
          const pending = state.pending;
          if (pending === null || pending.query !== update.query) return;
          state.pending = null;
          pending.removeAbortListener();
          pending.resolve(fileSearchEntries(update.files, pending.limit));
        },
      }).catch((error) => {
        state.session = null;
        throw error;
      });
      return state.session;
    };
    return {
      subscribeSkillsChanged(listener) {
        skillListeners.current.add(listener);
        return () => { skillListeners.current.delete(listener); };
      },
      async search(query, signal) {
        const text = query.query.trim();
        if (!shouldSearchComposerCatalog(query.kind, text)) return [];
        if (targetHostId(query.target) !== snapshot.hostId) return [];
        if (signal?.aborted) throw abortError();
        if (query.kind === "mention") {
          if (roots.length === 0) return [];
          state.pending?.removeAbortListener();
          state.pending?.reject(abortError());
          state.pending = null;
          return new Promise((resolve, reject) => {
            const abort = () => {
              if (state.pending?.reject !== reject) return;
              state.pending = null;
              reject(abortError());
            };
            signal?.addEventListener("abort", abort, { once: true });
            state.pending = {
              query: text,
              limit: query.limit,
              resolve,
              reject,
              removeAbortListener: () => signal?.removeEventListener("abort", abort),
            };
            void ensureFileSearchSession().then((session) => session.update(text)).catch((error: unknown) => {
              if (state.pending?.reject !== reject) return;
              state.pending.removeAbortListener();
              state.pending = null;
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          });
        }
        if (query.kind !== "skill") return [];
        const scope = query.target.type === "new-thread"
          ? { model: query.model }
          : { threadId: query.target.key.threadId };
        const response = await queryClient.fetchQuery({
          queryKey: ["appserver", snapshot.hostId, "skills", scope, roots, skillRevision.current] as const,
          queryFn: async () => {
            const result = await runtime.resources.composerCatalog.listSkills({ cwds: roots, forceReload: false, ...scope });
            assertSkillDiscoveryAvailable(result);
            return result;
          },
          staleTime: 5 * 60_000,
          gcTime: 5 * 60_000,
        });
        if (signal?.aborted) throw abortError();
        return searchAppServerSkills(response, text, query.limit);
      },
    };
  }, [queryClient, rootKey, runtime, snapshot.hostId]);
}

/** Opening the model menu is the only admission for inactive engine catalogs. */
export function useWorkInEngineCatalog(hostIds: readonly string[], activeHostId: string) {
  const application = useContext(ApplicationRuntimeContext);
  if (!application) throw new Error("AppServerRuntimeProvider is missing");
  const [requestedMachine, setRequestedMachine] = useState<string | null>(null);
  const machineKey = JSON.stringify(hostIds);
  const queries = useQueries({ queries: hostIds.map(hostId => ({
    queryKey: ["appserver", hostId, "work-in-models"],
    enabled: requestedMachine === machineKey && hostId !== activeHostId,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const runtime = await application.registry.ensureConnected(hostId);
      signal.throwIfAborted();
      return composerCapabilitiesOptions(hostId, null, runtime.resources.composerCatalog).queryFn!({ signal } as never);
    },
  })) });
  return {
    open: () => setRequestedMachine(machineKey),
    groups: hostIds.map((hostId, index) => ({ hostId, models: queries[index]?.data?.models ?? [],
      loading: requestedMachine === machineKey && queries[index]?.isPending === true,
      error: errorOrNull(queries[index]?.error)?.message ?? null,
      retry: () => { void queries[index]?.refetch(); },
    })),
  };
}

export function useMachineConnectionPhase(hostIds: readonly string[]): string {
  const application = useContext(ApplicationRuntimeContext);
  if (!application) throw new Error("AppServerRuntimeProvider is missing");
  const signature = JSON.stringify(hostIds);
  const subscribe = useCallback((listener: () => void) => {
    let stops: (() => void)[] = [];
    const attach = () => {
      stops.forEach(stop => stop());
      stops = hostIds.flatMap(id => {
        const runtime = application.registry.peekRuntime(id);
        return runtime ? [runtime.subscribe(listener)] : [];
      });
      listener();
    };
    const stopRegistry = application.registry.subscribe(attach);
    attach();
    return () => { stopRegistry(); stops.forEach(stop => stop()); };
  }, [application.registry, signature]);
  const read = () => {
    const phases = hostIds.map(id => application.registry.peekRuntime(id)?.getSnapshot().phase ?? "idle");
    return phases.includes("ready") ? "ready" : phases.includes("connecting") ? "connecting" : phases.includes("reconnecting") ? "reconnecting" : phases.includes("error") ? "error" : "idle";
  };
  return useSyncExternalStore(subscribe, read, read);
}
