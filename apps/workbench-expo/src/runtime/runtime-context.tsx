import { WORKBENCH_RESOURCE_POLICIES } from "@opencraft/workbench-runtime";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import type { PermissionProfileSummary, Project, Thread } from "@opencraft/appserver-protocol/generated/v2";
import { OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION } from "@opencraft/appserver-protocol";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import {
  createClientId,
  type ComposerController,
  type SubmissionReceipt,
  type SubmitIntent,
} from "@opencraft/composer-core";
import {
  createAppServerWorkbenchRuntime,
  createThreadViewFrameScheduler,
  createConversationBindingStore,
  createConversationActivationCoordinator,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createConversationDraftContinuity,
  createConversationDisplayContinuity,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  createWorkbenchSubmissionPipeline,
  encodeWorkbenchLocation,
  HostRuntimeRegistry,
  projectAppServerThread,
  projectComposerModelChoices,
  type AppServerWorkbenchRuntime,
  type AppServerWorkbenchViewSnapshot,
  type AppServerThreadRuntimeLease,
  type ConversationScopeRegistrySnapshot,
  type ConversationScopeRegistry,
  type ConversationBindingStore,
  type WorkbenchThread,
  type WorkbenchComposerModelChoice,
  type HostRuntimeDescriptor,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
  type ConversationDisplayContinuity,
} from "@opencraft/workbench-runtime";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { AppState, Platform } from "react-native";


interface WorkbenchRuntimeContextValue {
  readonly runtime: AppServerWorkbenchRuntime;
  readonly host: HostRuntimeDescriptor;
  readonly activeThreadLease: AppServerThreadRuntimeLease | null;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly composerController: ComposerController;
  readonly displayContinuity: ConversationDisplayContinuity | null;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  activateThread(threadId: string): Promise<boolean>;
  openDraft(cwd?: string): Promise<void>;
}

export interface ExpoWorkbenchApplication {
  readonly runtime: AppServerWorkbenchRuntime;
  readonly host: HostRuntimeDescriptor;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly coordinator: ReturnType<typeof createWorkbenchCoordinator<AppServerWorkbenchRuntime>>;
  readonly conversationActivation: ReturnType<typeof createConversationActivationCoordinator<AppServerWorkbenchRuntime>>;
  readonly leases: ReturnType<typeof createConversationScopeLeaseRegistry>;
  readonly views: ReturnType<typeof createConversationViewRegistry>;
  readonly bindings: ConversationBindingStore;
  readonly queryClient: QueryClient;
  readonly displayContinuity: ConversationDisplayContinuity | null;
  readonly submissionPipeline: ReturnType<typeof createWorkbenchSubmissionPipeline>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

const RuntimeContext = createContext<WorkbenchRuntimeContextValue | null>(null);

export function useWorkbenchController(): WorkbenchRuntimeContextValue {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("WorkbenchRuntimeProvider is missing");
  return value;
}

function appServerUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APPSERVER_WS_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  if (Platform.OS === "web" && typeof location !== "undefined") {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.hostname}:9988/rpc`;
  }
  // A physical device must configure its own reachable AppServer endpoint.
  return "ws://127.0.0.1:9988/rpc";
}

function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : null;
}

function createWorkbenchQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (failureCount >= 3) return false;
          const status = getHttpStatus(error);
          return status === null || status === 408 || status === 429 || status >= 500;
        },
      },
    },
  });
}

export interface ExpoWorkbenchApplicationOptions {
  readonly hostId?: string;
  readonly hostLabel?: string;
  readonly transport?: DuplexTransport;
  readonly transportEndpoint?: string | null;
  readonly initialDraftId?: string;
  readonly draftNamespace?: string;
  readonly draftStorage?: ConversationDraftStorage;
  readonly displayNamespace?: string;
  readonly displayStorage?: ConversationDisplayStorage;
}

export function createExpoWorkbenchApplication(options: ExpoWorkbenchApplicationOptions = {}): ExpoWorkbenchApplication {
    const hostId = asHostId(options.hostId ?? process.env.EXPO_PUBLIC_APPSERVER_HOST_ID ?? "local");
    const transport = options.transport ?? new WebSocketTransport({ url: appServerUrl() });
    const runtime = createAppServerWorkbenchRuntime({
      ...WORKBENCH_RESOURCE_POLICIES.mobile,
      frameScheduler: createThreadViewFrameScheduler((flush) => {
        if (AppState.currentState !== "active") return undefined;
        const frame = requestAnimationFrame(flush);
        return () => cancelAnimationFrame(frame);
      }, () => AppState.currentState === "active" ? 32 : 250),
      hostId,
      transport,
      autoReconnect: true,
    });
    const conversationScopes = createConversationScopeRegistry({
      initialDraft: {
        draftId: options.initialDraftId,
        entrypoint: "home",
        execution: {
          hostId,
          workspace: { cwd: null, runtimeWorkspaceRoots: [] },
        },
      },
    });
    const draft = conversationScopes.getActiveDraft();
    if (draft === null) throw new Error("Expo Workbench requires an initial Conversation Scope");
    const host: HostRuntimeDescriptor = Object.freeze({
        hostId,
        label: options.hostLabel ?? "AppServer",
        kind: "remote-control",
        transportEndpoint: options.transportEndpoint === undefined ? appServerUrl() : options.transportEndpoint,
        executionLocation: options.hostLabel ?? "AppServer",
        workspaceBrowseRoots: [],
    });
    const registry = new HostRuntimeRegistry([{
      descriptor: host,
      createRuntime: () => runtime,
    }]);
    const initialLocation = createWorkbenchDraftLocation(hostId, draft.id);
    const initialViewId = encodeWorkbenchLocation(initialLocation);
    const coordinator = createWorkbenchCoordinator(registry, initialLocation, hostId, initialViewId);
    const bindings = createConversationBindingStore();
    const leases = createConversationScopeLeaseRegistry({ maxInactiveScopes: WORKBENCH_RESOURCE_POLICIES.mobile.maxInactiveScopes });
    const views = createConversationViewRegistry({
      maxInactiveViews: WORKBENCH_RESOURCE_POLICIES.mobile.maxInactiveViews,
      scopeLeases: leases,
      composerServices: { now: Date.now, createId: createClientId },
      draftContinuity: options.draftNamespace && options.draftStorage
        ? createConversationDraftContinuity({ namespace: options.draftNamespace, storage: options.draftStorage })
        : undefined,
    });
    const conversationActivation = createConversationActivationCoordinator(
      coordinator,
      bindings,
      conversationScopes,
      leases,
      views,
    );
    // Native React renders immediately. Publish the locally owned Draft/View
    // identity synchronously; Host connection and hydration may finish later.
    // Supplying an initial coordinator viewId alone does not create its View.
    conversationActivation.mountInitial(initialLocation, initialViewId);
    const queryClient = createWorkbenchQueryClient();
    const displayContinuity = options.displayNamespace && options.displayStorage
      ? createConversationDisplayContinuity({ namespace: options.displayNamespace, storage: options.displayStorage })
      : null;
    const submissionPipeline = createWorkbenchSubmissionPipeline({
      scopes: conversationScopes,
      submitNewThread: (intent) => runtime.createThread(intent),
      submitExistingThread(intent) {
        const lease = coordinator.getActiveThreadLease();
        if (lease === null) return Promise.reject(new Error("No active Thread View is available"));
        return lease.submit(intent);
      },
      submitFirstTurn(intent, threadReceipt) {
        const lease = coordinator.getActiveThreadLease();
        if (lease === null || lease.threadId !== threadReceipt.threadId) {
          return Promise.reject(new Error("Promoted Thread View does not own its first Turn"));
        }
        return lease.submit({
          ...intent,
          target: {
            type: "existing-thread",
            key: createConversationKey(threadReceipt.hostId, threadReceipt.threadId),
          },
        });
      },
      async promoteDraft(draftId, receipt) {
        const prepared = await conversationActivation.preparePromotion(draftId, receipt);
        if (prepared === null || !prepared.commit(coordinator.getSnapshot().viewId ?? initialViewId)) {
          throw new Error("Draft promotion activation failed");
        }
      },
      async afterAccepted(receipt) {
        await queryClient.invalidateQueries({
          queryKey: ["appserver", receipt.hostId, "threads"],
        });
      },
    });
    let startPromise: Promise<void> | null = null;
    let disposed = false;
    return {
      runtime,
      host,
      conversationScopes,
      registry,
      coordinator,
      conversationActivation,
      leases,
      views,
      bindings,
      queryClient,
      displayContinuity,
      submissionPipeline,
      start() {
        if (disposed) return Promise.reject(new Error("Expo Workbench application is disposed"));
        startPromise ??= conversationActivation.prepare(initialLocation).then((prepared) => {
          if (prepared === null || !prepared.commit(initialViewId)) {
            throw coordinator.getSnapshot().error ?? new Error("Initial activation failed");
          }
        });
        return startPromise;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        conversationActivation.dispose();
        views.dispose();
        leases.dispose();
        conversationScopes.dispose();
        bindings.dispose();
        coordinator.dispose();
        queryClient.clear();
        await registry.dispose();
      },
    };
}

export function WorkbenchRuntimeProvider({
  application,
  children,
}: {
  readonly application: ExpoWorkbenchApplication;
  readonly children: ReactNode;
}) {
  const { runtime } = application;
  const coordinatorSnapshot = useSyncExternalStore(
    application.coordinator.subscribe,
    application.coordinator.getSnapshot,
    application.coordinator.getSnapshot,
  );
  const draftSnapshot = useSyncExternalStore(
    application.conversationScopes.subscribe,
    application.conversationScopes.getSnapshot,
    application.conversationScopes.getSnapshot,
  );
  const conversationScopeId = application.conversationActivation.scopeIdFor(coordinatorSnapshot.location);
  const conversationViewId = coordinatorSnapshot.viewId;
  if (conversationViewId === null) throw new Error("Active Conversation View has no identity");
  const activeThreadLease = application.coordinator.getActiveThreadLease();
  const conversationView = application.views.get(conversationViewId);
  if (conversationView === null || conversationView.scopeId !== conversationScopeId) {
    throw new Error(`Conversation View ${conversationViewId} is unavailable`);
  }
  const composerController = conversationView.composer;
  const contextValue = useMemo<WorkbenchRuntimeContextValue>(() => ({
    runtime,
    host: application.host,
    activeThreadLease,
    conversationScopes: application.conversationScopes,
    composerController,
    displayContinuity: application.displayContinuity,
    submit: application.submissionPipeline.submit,
    async activateThread(threadId) {
      const location = createWorkbenchThreadLocation(runtime.getSnapshot().hostId, threadId);
      const prepared = await application.conversationActivation.prepare(location);
      return prepared?.commit(encodeWorkbenchLocation(location)) ?? false;
    },
    async openDraft(cwd) {
      const opened = application.conversationScopes.openDraft({
        execution: {
          hostId: runtime.getSnapshot().hostId,
          workspace: { cwd: cwd ?? null, runtimeWorkspaceRoots: cwd ? [cwd] : [] },
        },
        entrypoint: "new-chat",
      });
      const location = createWorkbenchDraftLocation(runtime.getSnapshot().hostId, opened.id);
      const prepared = await application.conversationActivation.prepare(location);
      if (prepared === null || !prepared.commit(encodeWorkbenchLocation(location))) {
        throw new Error("Draft activation failed");
      }
    },
  }), [activeThreadLease, application, composerController, draftSnapshot.revision, runtime]);

  useEffect(() => {
    void application.start().catch(() => undefined);
  }, [application]);

  return (
    <QueryClientProvider client={application.queryClient}>
      <RuntimeContext.Provider value={contextValue}>{children}</RuntimeContext.Provider>
    </QueryClientProvider>
  );
}

export function useWorkbenchRuntime(): AppServerWorkbenchRuntime {
  return useWorkbenchController().runtime;
}

export function useActiveHostDescriptor(): HostRuntimeDescriptor {
  return useWorkbenchController().host;
}

export function useActiveWorkbenchThread(): AppServerThreadRuntimeLease | null {
  return useWorkbenchController().activeThreadLease;
}

export function useConversationScopeRegistry(): ConversationScopeRegistry {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("WorkbenchRuntimeProvider is missing");
  return value.conversationScopes;
}

export function useConversationScopeRegistrySnapshot(): ConversationScopeRegistrySnapshot {
  const session = useConversationScopeRegistry();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useRootComposerController(): ComposerController {
  return useWorkbenchController().composerController;
}

export function useWorkbenchSnapshot(): AppServerWorkbenchViewSnapshot {
  const runtime = useWorkbenchRuntime();
  const activeThreadLease = useActiveWorkbenchThread();
  const hostSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const getConversationSnapshot = activeThreadLease === null
    ? () => null
    : activeThreadLease.getSnapshot;
  const conversation = useSyncExternalStore(
    activeThreadLease?.subscribe ?? ((_listener: () => void) => () => undefined),
    getConversationSnapshot,
    getConversationSnapshot,
  );
  return useMemo(() => ({
    ...hostSnapshot,
    activeThreadId: activeThreadLease?.threadId ?? null,
    conversation,
  }), [activeThreadLease?.threadId, conversation, hostSnapshot]);
}

export function useComposerModelCatalog(): {
  readonly models: readonly WorkbenchComposerModelChoice[];
  readonly isFetching: boolean;
  readonly error: Error | null;
  readonly refetch: () => Promise<unknown>;
} {
  const runtime = useWorkbenchRuntime();
  const snapshot = useWorkbenchSnapshot();
  const enabled = snapshot.phase === "ready" || snapshot.phase === "reconnecting";
  const supportsScopedModelCatalog = runtime.resources.host.getInitializeResult()
    ?.capabilities?.extensions?.[OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION] !== undefined;
  const owner = supportsScopedModelCatalog ? snapshot.activeThreadId : null;
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "composer-models", owner ?? "host"] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listModels({
      cursor: pageParam,
      limit: 100,
      includeHidden: false,
      ...(owner === null ? {} : { threadId: owner }),
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);
  const models = useMemo(
    () => projectComposerModelChoices(query.data?.pages.flatMap((page) => page.data) ?? []),
    [query.data],
  );
  return {
    models,
    isFetching: query.isFetching,
    error: query.error == null
      ? null
      : query.error instanceof Error ? query.error : new Error(String(query.error)),
    refetch: query.refetch,
  };
}

export function useComposerPermissionProfiles(cwd: string | null): readonly PermissionProfileSummary[] {
  const runtime = useWorkbenchRuntime();
  const snapshot = useWorkbenchSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "permission-profiles", cwd] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listPermissionProfiles({
      cursor: pageParam, limit: 100, cwd: cwd ?? undefined,
    }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);
  return useMemo(() => query.data?.pages.flatMap(page => page.data) ?? [], [query.data]);
}

export function useProjectCatalog(active: boolean): readonly Project[] {
  const runtime = useWorkbenchRuntime();
  const snapshot = useWorkbenchSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "projects"] as const,
    enabled: active && (snapshot.phase === "ready" || snapshot.phase === "reconnecting"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.projects.list({ cursor: pageParam, limit: 100 }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (active && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [active, query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);
  return useMemo(() => query.data?.pages.flatMap(page => page.data) ?? [], [query.data]);
}

export function useThreadCatalog(): {
  readonly protocolThreads: readonly Thread[];
  readonly threads: readonly WorkbenchThread[];
  readonly hasNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly isFetching: boolean;
} {
  const runtime = useWorkbenchRuntime();
  const snapshot = useWorkbenchSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "threads", "updated_at", "desc", false] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.threads.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const protocolThreads = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const threads = useMemo(
    () => protocolThreads.map((thread) => projectAppServerThread(thread)),
    [protocolThreads],
  );
  return {
    protocolThreads,
    threads,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetching: query.isFetching,
  };
}
