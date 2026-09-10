import {
  createCordisAppServerRegistry,
  type AppServerClient,
  type AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AgentListParams,
  AgentListResponse,
  ModelListParams,
  ModelListResponse,
  PermissionProfileListParams,
  PermissionProfileListResponse,
  SkillsListParams,
  SkillsListResponse,
  ProjectCreateParams,
  ProjectCreateResponse,
  ProjectListParams,
  ProjectListResponse,
  FsReadDirectoryResponse,
  FsReadFileResponse,
  ReplicaJsonValue,
  ThreadListParams,
  ThreadListResponse,
  ThreadQueueListResponse,
  QueuedSubmission as ProtocolQueuedSubmission,
  ThreadStartParams,
} from "@opencraft/appserver-protocol";
import {
  OPENCRAFT_AGENT_CATALOG_CAPABILITY,
  OPENCRAFT_AGENT_CATALOG_EXTENSION,
} from "@opencraft/appserver-protocol";
import type {
  DynamicToolSpec,
  FsChangedNotification,
  FsGetMetadataResponse,
  FsWatchResponse,
  FsWriteFileResponse,
  ThreadQueueChangedNotification,
  Thread as ProtocolThread,
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  ReplicaClient,
  type ReplicaClientStorage,
} from "@opencraft/appserver-replica";
import {
  codexThreadReplicaScope,
  createCodexV3ConversationNavigationSource,
  createCodexThreadReplicaSource,
  createCordisThreadSessionRuntime,
  createThreadViewReplicaProjectionBarrier,
  mergeTurns,
  projectThreadViewForReplica,
  type AppServerHostKind,
  type CordisThreadSessionRuntime,
} from "@opencraft/appserver-session";
import {
  asHostId,
  createConversationKey,
  type HostId,
  type TurnId,
} from "@opencraft/chat-core";
import {
  createReplicaConversationRuntime,
  type ConversationCommandPort,
  type ConversationRuntime,
  type ConversationRuntimeSnapshot,
  type InteractionResponse,
} from "@opencraft/chat-runtime";
import {
  AppServerFuzzyFileSearchController,
  AppServerInteractionBroker,
  createAppServerConversationCommandPort,
  type FuzzyFileSearchSession,
  type FuzzyFileSearchSessionOptions,
} from "@opencraft/composer-appserver";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import {
  ConversationNavigationController,
  type ConversationNavigationSource,
} from "@opencraft/chat-navigation";
import {
  AppServerTerminalController,
  type AppServerTerminalResourcePort,
} from "./appserver-terminal";

export type AppServerWorkbenchPhase =
  "idle" | "connecting" | "ready" | "reconnecting" | "error" | "disposed";

export type ThreadRuntimeResidencyPhase =
  | "preparing"
  | "hydrating"
  | "resident"
  | "reconnecting"
  | "evictable"
  | "disposing"
  | "disposed"
  | "error";

export interface ThreadRuntimeResidencySnapshot {
  readonly threadId: string;
  readonly phase: ThreadRuntimeResidencyPhase;
  readonly viewLeaseCount: number;
  readonly subscriberCount: number;
  readonly pendingCommandCount: number;
  readonly activeStreamCount: number;
  readonly pendingInteractionCount: number;
  readonly hydrating: boolean;
  readonly authoritative: boolean;
  readonly touchedAt: number;
}

export interface AppServerWorkbenchSnapshot {
  readonly revision: number;
  readonly phase: AppServerWorkbenchPhase;
  readonly hostId: HostId;
  readonly connectionGeneration: number;
  readonly transport: TransportStatus;
  /** Host-owned Thread runtimes, including inactive background work. */
  readonly residentThreads: readonly ThreadRuntimeResidencySnapshot[];
  readonly error: Error | null;
}

/** View projection layered over a Host snapshot by a View-owned Thread lease. */
export interface AppServerWorkbenchViewSnapshot extends AppServerWorkbenchSnapshot {
  readonly activeThreadId: string | null;
  readonly conversation: ConversationRuntimeSnapshot | null;
}

export interface AppServerRuntimeClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface AppServerWorkbenchRuntimeConfig {
  readonly hostId: string;
  readonly transport: DuplexTransport;
  readonly hostKind?: AppServerHostKind;
  readonly initialize?: AppServerInitializeParams;
  readonly requestTimeoutMs?: number;
  readonly pageSize?: number;
  readonly autoReconnect?: boolean;
  readonly reconnectDelaysMs?: readonly number[];
  readonly maxInactiveThreads?: number;
  readonly clock?: AppServerRuntimeClock;
  readonly dynamicTools?: readonly DynamicToolSpec[];
  /** Installs host-scoped server-request handlers before initialize. */
  readonly installClientHandlers?: (client: AppServerClient) => () => void;
  /** Application-owned multi-Host Cordis registry. Omit for isolated tests. */
  readonly clientRegistry?: Pick<
    AppServerClientRegistryService,
    "create" | "remove"
  >;
}

export interface StartThreadOptions {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly projectId?: string | null;
  readonly model?: string;
  readonly historyMode?: "legacy" | "paginated";
  readonly agentId?: string;
}

export interface AppServerThreadResourcePort {
  list(params?: Partial<ThreadListParams>): Promise<ThreadListResponse>;
  start(options: StartThreadOptions): Promise<ProtocolThread>;
}

export interface AppServerComposerCatalogResourcePort {
  listAgents(params?: Partial<AgentListParams>): Promise<AgentListResponse>;
  listModels(params?: Partial<ModelListParams>): Promise<ModelListResponse>;
  listPermissionProfiles(
    params?: Partial<PermissionProfileListParams>,
  ): Promise<PermissionProfileListResponse>;
  listSkills(params?: Partial<SkillsListParams>): Promise<SkillsListResponse>;
  createFuzzyFileSearchSession(
    options: FuzzyFileSearchSessionOptions,
  ): Promise<FuzzyFileSearchSession>;
  subscribeSkillsChanged(listener: () => void): () => void;
  subscribeAgentsChanged(listener: () => void): () => void;
}

export interface AppServerProjectResourcePort {
  list(params?: Partial<ProjectListParams>): Promise<ProjectListResponse>;
  create(params: ProjectCreateParams): Promise<ProjectCreateResponse>;
}

/** Host-scoped facts and capabilities; it never owns Conversation state. */
export interface AppServerHostResourcePort {
  getInitializeResult(): AppServerInitializeResponse | null;
  getConnectionGeneration?(): number;
  /**
   * Fetches an HTTP endpoint in the physical Host's loopback namespace.
   * The Host transport owns the tunnel; callers only own the request signal.
   */
  fetchLoopback(input: string, init?: RequestInit): Promise<Response>;
}

interface AppServerLoopbackHttpTransport {
  fetchLoopback(input: string, init?: RequestInit): Promise<Response>;
}

function loopbackHttpTransport(
  transport: DuplexTransport,
): AppServerLoopbackHttpTransport | null {
  const candidate = transport as DuplexTransport & Partial<AppServerLoopbackHttpTransport>;
  if (typeof candidate.fetchLoopback !== "function") return null;
  return {
    fetchLoopback: (input, init) => candidate.fetchLoopback!(input, init),
  };
}

export interface AppServerFileSystemResourcePort {
  getMetadata(path: string, signal?: AbortSignal): Promise<FsGetMetadataResponse>;
  readDirectory(path: string): Promise<FsReadDirectoryResponse>;
  readFile(path: string, signal?: AbortSignal): Promise<FsReadFileResponse>;
  writeFile(path: string, dataBase64: string): Promise<FsWriteFileResponse>;
  watch(
    path: string,
    listener: (changedPaths: readonly string[]) => void,
  ): Promise<AppServerFileWatchLease>;
  createFuzzyFileSearchSession(
    options: FuzzyFileSearchSessionOptions,
  ): Promise<FuzzyFileSearchSession>;
}

export interface AppServerFileWatchLease {
  readonly watchId: string;
  readonly path: string;
  dispose(): Promise<void>;
}

export interface AppServerWorkbenchRuntime {
  readonly resources: {
    readonly host: AppServerHostResourcePort;
    readonly threads: AppServerThreadResourcePort;
    readonly projects: AppServerProjectResourcePort;
    readonly fileSystem: AppServerFileSystemResourcePort;
    readonly composerCatalog: AppServerComposerCatalogResourcePort;
    readonly terminal: AppServerTerminalResourcePort;
  };
  getSnapshot(): AppServerWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects the Host. It never chooses or restores a Thread. */
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  acquireThread(threadId: string): Promise<AppServerThreadRuntimeLease>;
  /** Creates a Thread only; its first Turn is submitted by the promoted Conversation Runtime. */
  createThread(intent: SubmitIntent): Promise<SubmissionReceipt>;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  getThreadResidency(threadId: string): ThreadRuntimeResidencySnapshot | null;
  dispose(): Promise<void>;
}

export interface AppServerThreadRuntimeLease {
  readonly threadId: string;
  getSnapshot(): ConversationRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry this Thread's baseline without navigating or reconnecting its Host. */
  retryRestore(): Promise<void>;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  interrupt(turnId: TurnId): Promise<void>;
  continueTurn(turnId: TurnId): Promise<SubmissionReceipt>;
  respond(response: InteractionResponse): Promise<void>;
  updateQueuedSubmission(
    queuedSubmissionId: string,
    input: readonly UserInput[],
  ): Promise<void>;
  deleteQueuedSubmission(queuedSubmissionId: string): Promise<void>;
  reorderQueuedSubmissions(
    queuedSubmissionIds: readonly string[],
  ): Promise<void>;
  startQueuedSubmission(queuedSubmissionId?: string): Promise<TurnId>;
  steerQueuedSubmission(queuedSubmissionId: string): Promise<TurnId>;
  loadOlder(): Promise<void>;
  getNavigation(): ConversationNavigationSource;
  release(): void;
}

interface ConversationBinding {
  readonly threadId: string;
  readonly replica: ReplicaClient<ReplicaJsonValue>;
  readonly runtime: ConversationRuntime;
  readonly navigation: ConversationNavigationSource;
  removeRuntimeListener: () => void;
  removeQueueListener: () => void;
  queueRefreshOperation: Promise<void> | null;
  queueRefreshRequested: boolean;
  retainCount: number;
  touchedAt: number;
  hydrationOperation: Promise<void> | null;
  hydrationForReconnect: boolean;
  phase: ThreadRuntimeResidencyPhase;
  subscriberCount: number;
  pendingCommandCount: number;
  readonly acceptedTurnIds: Set<string>;
  disposed: boolean;
}

const defaultClock: AppServerRuntimeClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
};

const defaultInitialize: AppServerInitializeParams = {
  clientInfo: { name: "opencraft-workbench", version: "0.1.0" },
  capabilities: {
    experimentalApi: true,
    extensions: {
      [OPENCRAFT_AGENT_CATALOG_EXTENSION]: OPENCRAFT_AGENT_CATALOG_CAPABILITY,
    },
  },
};

function requireThreadId(threadId: string): string {
  if (threadId.trim().length === 0)
    throw new RangeError("Thread ID must not be empty");
  return threadId;
}

function storageKey(hostId: HostId, threadId: string): string {
  return `chat-runtime:${hostId}:${threadId}`;
}

/**
 * A projected V3 ThreadView is not a durable Replica checkpoint. Its epoch and
 * revision are local to the current AppServer connection, so restoring it on a
 * later connection can only produce an unverified, second visible Timeline.
 *
 * Keep the Replica client as the live projection boundary, but deliberately
 * make its storage volatile. True V4 Replica clients retain their own durable
 * storage and cursor semantics in @opencraft/appserver-replica.
 */
const volatileThreadViewReplicaStorage: ReplicaClientStorage<ReplicaJsonValue> = {
  async loadClient() {
    return null;
  },
  async commitClient() {},
  async clearClient() {},
};

export function createAppServerWorkbenchRuntime(
  config: AppServerWorkbenchRuntimeConfig,
): AppServerWorkbenchRuntime {
  const hostId = asHostId(config.hostId);
  const clock = config.clock ?? defaultClock;
  const reconnectDelays = config.reconnectDelaysMs ?? [
    250, 500, 1_000, 2_000, 5_000,
  ];
  const maxInactiveThreads = config.maxInactiveThreads ?? 4;
  const listeners = new Set<() => void>();
  const bindings = new Map<string, ConversationBinding>();
  const bindingOperations = new Map<string, Promise<ConversationBinding>>();
  let revision = 0;
  let phase: AppServerWorkbenchPhase = "idle";
  let error: Error | null = null;
  let disposed = false;
  let lifecycleGeneration = 0;
  let disposeOperation: Promise<void> | null = null;
  let startOperation: Promise<void> | null = null;
  let reconnectOperation: Promise<void> | null = null;
  let initializeServicesOperation: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let automaticReconnectBlock: TransportStatus | null = null;
  let loggedReconnectStopCode: string | null = null;
  let logicalClock = 0;
  let ownedRegistry: Awaited<
    ReturnType<typeof createCordisAppServerRegistry>
  > | null = null;
  let client: AppServerClient | null = null;
  let session: CordisThreadSessionRuntime | null = null;
  let interactions: AppServerInteractionBroker | null = null;
  let fuzzyFileSearch: AppServerFuzzyFileSearchController | null = null;
  let commandPort: ReturnType<
    typeof createAppServerConversationCommandPort
  > | null = null;
  let terminalController: AppServerTerminalController | null = null;
  let removeTransportListener: (() => void) | null = null;
  let removeClientHandlers: (() => void) | null = null;
  let removeFileSystemNotificationListener: (() => void) | null = null;
  let fileSystemWatchSequence = 0;
  const fileSystemWatches = new Map<string, {
    readonly path: string;
    readonly listener: (changedPaths: readonly string[]) => void;
  }>();
  let snapshot: AppServerWorkbenchSnapshot;

  const ensureLifecycle = (generation: number) => {
    if (disposed || generation !== lifecycleGeneration) {
      throw new Error("AppServer Workbench lifecycle was superseded");
    }
  };

  const bindingActivity = (binding: ConversationBinding) => {
    const conversationSnapshot = binding.runtime.getSnapshot();
    return {
      activeStreamCount: conversationSnapshot.activeTurn === null ? 0 : 1,
      pendingInteractionCount: conversationSnapshot.pendingInteractions.length,
      authoritative: conversationSnapshot.authoritative,
    };
  };

  const residencySnapshot = (
    binding: ConversationBinding,
  ): ThreadRuntimeResidencySnapshot => {
    const activity = bindingActivity(binding);
    return Object.freeze({
      threadId: binding.threadId,
      phase: binding.phase,
      viewLeaseCount: binding.retainCount,
      subscriberCount: binding.subscriberCount,
      pendingCommandCount:
        binding.pendingCommandCount + binding.acceptedTurnIds.size,
      activeStreamCount: activity.activeStreamCount,
      pendingInteractionCount: activity.pendingInteractionCount,
      hydrating: binding.hydrationOperation !== null,
      authoritative: activity.authoritative,
      touchedAt: binding.touchedAt,
    });
  };

  const hasHardResidencyReason = (binding: ConversationBinding): boolean => {
    const activity = bindingActivity(binding);
    return (
      binding.retainCount > 0 ||
      binding.subscriberCount > 0 ||
      binding.pendingCommandCount > 0 ||
      binding.acceptedTurnIds.size > 0 ||
      activity.activeStreamCount > 0 ||
      activity.pendingInteractionCount > 0 ||
      binding.hydrationOperation !== null
    );
  };

  const derive = (): AppServerWorkbenchSnapshot => ({
    revision,
    phase,
    hostId,
    connectionGeneration: client?.connectionGeneration ?? 0,
    transport: client?.status ?? config.transport.status,
    residentThreads: [...bindings.values()]
      .filter((binding) => !binding.disposed)
      .map(residencySnapshot),
    error,
  });
  snapshot = derive();

  const publish = () => {
    if (disposed) return;
    revision += 1;
    snapshot = derive();
    for (const listener of listeners) listener();
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return;
    console.log("[appserver-reconnect] cancelled", { hostId, attempt: reconnectAttempt });
    clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = (transportStatus?: TransportStatus) => {
    if (disposed || config.autoReconnect === false || reconnectTimer !== null)
      return;
    const effectiveStatus = automaticReconnectBlock ?? transportStatus ?? config.transport.status;
    if (effectiveStatus.failure?.recovery === "manual") {
      if (loggedReconnectStopCode !== effectiveStatus.failure.code) {
        loggedReconnectStopCode = effectiveStatus.failure.code;
        console.log("[appserver-reconnect] automatic-reconnect-stopped", {
          hostId,
          code: effectiveStatus.failure.code,
          reason: effectiveStatus.reason,
        });
      }
      return;
    }
    loggedReconnectStopCode = null;
    const delay =
      reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ??
      5_000;
    reconnectAttempt += 1;
    console.log("[appserver-reconnect] scheduled", { hostId, attempt: reconnectAttempt, delayMs: delay });
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      // reconnect() owns classification and any subsequent retry schedule.
      void runtime.reconnect().catch(() => undefined);
    }, delay);
  };

  const requireClient = (): AppServerClient => {
    if (client === null) throw new Error("AppServer Workbench has not started");
    return client;
  };

  const requireSession = (): CordisThreadSessionRuntime => {
    if (session === null) throw new Error("AppServer Session has not started");
    return session;
  };

  const disposeBinding = (binding: ConversationBinding) => {
    if (binding.disposed) return;
    binding.phase = "disposing";
    binding.disposed = true;
    bindings.delete(binding.threadId);
    binding.removeRuntimeListener();
    binding.removeQueueListener();
    binding.navigation.dispose();
    binding.runtime.dispose();
    binding.replica.dispose();
    binding.phase = "disposed";
  };

  const pruneInactiveBindings = () => {
    const inactive = [...bindings.values()]
      .filter((binding) => !hasHardResidencyReason(binding))
      .sort((left, right) => left.touchedAt - right.touchedAt);
    for (const binding of inactive) binding.phase = "evictable";
    while (inactive.length > maxInactiveThreads)
      disposeBinding(inactive.shift()!);
    for (const binding of bindings.values()) {
      if (binding.phase === "evictable" && hasHardResidencyReason(binding)) {
        binding.phase = "resident";
      }
    }
  };

  const touchBinding = (binding: ConversationBinding) => {
    binding.touchedAt = ++logicalClock;
    if (binding.phase === "evictable") binding.phase = "resident";
  };

  const runBindingCommand = async <T>(
    binding: ConversationBinding,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (binding.disposed)
      throw new Error(`Thread ${binding.threadId} is disposed`);
    binding.pendingCommandCount += 1;
    touchBinding(binding);
    publish();
    try {
      return await operation();
    } finally {
      binding.pendingCommandCount = Math.max(
        0,
        binding.pendingCommandCount - 1,
      );
      touchBinding(binding);
      pruneInactiveBindings();
      publish();
    }
  };

  const retainAcceptedTurn = (binding: ConversationBinding, turnId: string) => {
    const frame = binding.runtime
      .getSnapshot()
      .timeline.frames.find((candidate) => candidate.turnId === turnId);
    if (
      frame === undefined ||
      frame.status === "pending" ||
      frame.status === "streaming"
    ) {
      binding.acceptedTurnIds.add(turnId);
    }
    touchBinding(binding);
  };

  const createBindingUnshared = async (
    threadId: string,
  ): Promise<ConversationBinding> => {
    const existing = bindings.get(threadId);
    if (existing !== undefined) return existing;
    const currentSession = requireSession();
    const currentClient = requireClient();
    if (commandPort === null)
      throw new Error("AppServer command port is unavailable");
    const currentCommandPort = commandPort;
    const replica = new ReplicaClient<ReplicaJsonValue>({
      scope: codexThreadReplicaScope(hostId, threadId),
      storageKey: storageKey(hostId, threadId),
      storage: volatileThreadViewReplicaStorage,
      pageSize: config.pageSize ?? 100,
    });
    let conversation: ConversationRuntime | null = null;
    let navigation: ConversationNavigationController | null = null;
    try {
      await replica.prepare();
      const afterAuthoritativeBaseline = async <T>(operation: () => Promise<T>): Promise<T> => {
        const owner = bindings.get(threadId);
        if (owner === undefined || owner.disposed) {
          throw new Error(`Thread ${threadId} is unavailable`);
        }
        // A local optimistic Item may paint immediately, but no AppServer
        // mutation may overtake the Thread's initial Resume. Otherwise a
        // concurrently completing snapshot and the live notification stream
        // can each publish the first user message, and a backend such as
        // Hermes cannot reconcile them because durable history has no client
        // message identity. Resume is the single baseline owner.
        if (!owner.runtime.getSnapshot().authoritative) {
          await hydrateBinding(owner, false);
        }
        return operation();
      };
      const baselineGatedCommands: ConversationCommandPort = {
        ...currentCommandPort,
        submit: (intent) => afterAuthoritativeBaseline(() => currentCommandPort.submit(intent)),
        interrupt: (key, turnId) => afterAuthoritativeBaseline(() => currentCommandPort.interrupt(key, turnId)),
        continueTurn: (key, turnId) => afterAuthoritativeBaseline(() => currentCommandPort.continueTurn(key, turnId)),
        respond: (key, response) => afterAuthoritativeBaseline(() => currentCommandPort.respond(key, response)),
        updateQueuedSubmission: (key, id, input) => afterAuthoritativeBaseline(
          () => currentCommandPort.updateQueuedSubmission(key, id, input),
        ),
        deleteQueuedSubmission: (key, id) => afterAuthoritativeBaseline(
          () => currentCommandPort.deleteQueuedSubmission(key, id),
        ),
        reorderQueuedSubmissions: (key, ids) => afterAuthoritativeBaseline(
          () => currentCommandPort.reorderQueuedSubmissions(key, ids),
        ),
        startQueuedSubmission: (key, id) => afterAuthoritativeBaseline(
          () => currentCommandPort.startQueuedSubmission(key, id),
        ),
        steerQueuedSubmission: (key, submission, activeTurnId) => afterAuthoritativeBaseline(
          () => currentCommandPort.steerQueuedSubmission(key, submission, activeTurnId),
        ),
      };
      conversation = createReplicaConversationRuntime({
        key: createConversationKey(hostId, threadId),
        replica,
        commands: baselineGatedCommands,
        history: {
          loadOlder: async () => {
            await currentSession.resume.loadOlder(threadId);
          },
        },
      });
      const projectionBarrier =
        createThreadViewReplicaProjectionBarrier(replica);
      navigation = new ConversationNavigationController(
        createCodexV3ConversationNavigationSource({
          threadId,
          port: {
            getView: () => currentSession.views.get(threadId),
            subscribeView: (listener) =>
              currentSession.views.subscribeThread(threadId, listener),
            listTurns: (params) =>
              currentClient.request("thread/turns/list", params, {
                priority: "background",
              }),
            projectionBarrier,
            commitHydratedTurn: (turn, chronologicalTurnIds) => {
              const order = new Map(
                chronologicalTurnIds.map((turnId, index) => [turnId, index]),
              );
              const committedView = currentSession.views.update(
                threadId,
                (current) => ({
                  ...current,
                  turns: [
                    ...mergeTurns(current.turns, [turn], {
                      placement: "prepend",
                    }),
                  ].sort((left, right) => {
                    const leftOrder = order.get(left.id);
                    const rightOrder = order.get(right.id);
                    if (leftOrder === undefined && rightOrder === undefined)
                      return 0;
                    if (leftOrder === undefined) return 1;
                    if (rightOrder === undefined) return -1;
                    return leftOrder - rightOrder;
                  }),
                }),
              );
              return {
                hostId: committedView.hostId,
                threadId: committedView.threadId,
                connectionGeneration: committedView.connectionGeneration,
                viewRevision: committedView.revision,
              };
            },
          },
        }),
      );
      const binding: ConversationBinding = {
        threadId,
        replica,
        runtime: conversation,
        navigation,
        removeRuntimeListener: () => undefined,
        removeQueueListener: () => undefined,
        queueRefreshOperation: null,
        queueRefreshRequested: false,
        retainCount: 0,
        touchedAt: ++logicalClock,
        hydrationOperation: null,
        hydrationForReconnect: false,
        phase: "preparing",
        subscriberCount: 0,
        pendingCommandCount: 0,
        acceptedTurnIds: new Set(),
        disposed: false,
      };
      binding.removeRuntimeListener = conversation.subscribe(() => {
        if (binding.disposed) return;
        const currentSnapshot = binding.runtime.getSnapshot();
        for (const turnId of binding.acceptedTurnIds) {
          const frame = currentSnapshot.timeline.frames.find(
            (candidate) => candidate.turnId === turnId,
          );
          if (
            frame !== undefined &&
            frame.status !== "pending" &&
            frame.status !== "streaming"
          ) {
            binding.acceptedTurnIds.delete(turnId);
          }
        }
        touchBinding(binding);
        if (binding.phase !== "hydrating" && binding.phase !== "reconnecting" && binding.phase !== "error") {
          binding.phase = hasHardResidencyReason(binding)
            ? "resident"
            : "evictable";
        }
        publish();
        globalThis.queueMicrotask(() => {
          if (disposed || binding.disposed) return;
          pruneInactiveBindings();
          publish();
        });
      });
      const refreshQueue = (): Promise<void> => {
        if (binding.queueRefreshOperation !== null) {
          binding.queueRefreshRequested = true;
          return binding.queueRefreshOperation;
        }
        const operation = (async () => {
          do {
            binding.queueRefreshRequested = false;
            const submissions: ProtocolQueuedSubmission[] = [];
            let cursor: string | null = null;
            do {
              const page: ThreadQueueListResponse = await currentClient.request(
                "thread/queue/list",
                {
                  threadId,
                  cursor,
                  limit: 100,
                },
                { priority: "background" },
              );
              submissions.push(...page.data);
              cursor = page.nextCursor;
            } while (cursor !== null);
            if (!disposed && !binding.disposed) {
              conversation!.replaceQueuedSubmissions(submissions);
            }
          } while (
            binding.queueRefreshRequested &&
            !disposed &&
            !binding.disposed
          );
        })().finally(() => {
          if (binding.queueRefreshOperation === operation) {
            binding.queueRefreshOperation = null;
          }
        });
        binding.queueRefreshOperation = operation;
        return operation;
      };
      binding.removeQueueListener = currentClient.subscribeNotification(
        (notification) => {
          if (
            notification.method !== "thread/queue/changed" ||
            (notification.params as ThreadQueueChangedNotification).threadId !==
              threadId
          )
            return;
          void refreshQueue().catch(() => undefined);
        },
      );
      bindings.set(threadId, binding);
      publish();
      // Queue hydration is deliberately not on the visible Thread critical
      // path. The Composer paints from its optimistic projection and is
      // reconciled when this background read completes.
      void refreshQueue().catch(() => undefined);
      return binding;
    } catch (cause) {
      navigation?.dispose();
      conversation?.dispose();
      replica.dispose();
      throw cause;
    }
  };

  const createBinding = (threadId: string): Promise<ConversationBinding> => {
    const existing = bindings.get(threadId);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = bindingOperations.get(threadId);
    if (pending !== undefined) return pending;
    const operation = createBindingUnshared(threadId).finally(() => {
      if (bindingOperations.get(threadId) === operation)
        bindingOperations.delete(threadId);
    });
    bindingOperations.set(threadId, operation);
    return operation;
  };

  const hydrateBinding = (
    binding: ConversationBinding,
    force: boolean,
  ): Promise<void> => {
    if (binding.disposed)
      return Promise.reject(
        new Error(`Thread ${binding.threadId} is disposed`),
      );
    if (binding.hydrationOperation !== null) {
      if (!force || binding.hydrationForReconnect)
        return binding.hydrationOperation;
      return binding.hydrationOperation
        .catch(() => undefined)
        .then(() => hydrateBinding(binding, true));
    }
    binding.hydrationForReconnect = force;
    binding.phase = force ? "reconnecting" : "hydrating";
    binding.replica.reportSyncStarted();
    touchBinding(binding);
    publish();
    const operation = Promise.resolve()
      .then(async () => {
        const currentSession = requireSession();
        if (force) binding.replica.disconnect();
        const stopPreview = currentSession.views.subscribeThread(binding.threadId, () => {
          const view = currentSession.views.get(binding.threadId);
          if (!binding.disposed && !disposed && view?.resumeState === "resuming" && view.historySource === "message-window") {
            binding.replica.reportPreview(binding.threadId, projectThreadViewForReplica(view));
          }
        });
        try {
          await currentSession.resume.resume({ threadId: binding.threadId, force });
        } finally { stopPreview(); }
        const source = createCodexThreadReplicaSource(
          currentSession.views,
          hostId,
          binding.threadId,
        );
        await binding.replica.synchronize(source);
        if (binding.disposed || disposed) return;
        binding.phase = "resident";
        touchBinding(binding);
      })
      .catch((cause) => {
        if (!binding.disposed && !disposed) {
          binding.phase = "error";
          if (binding.replica.getSnapshot().lastError === null) {
            binding.replica.reportSyncFailure(cause);
          }
        }
        throw cause;
      })
      .finally(() => {
        if (binding.hydrationOperation === operation) {
          binding.hydrationOperation = null;
          binding.hydrationForReconnect = false;
        }
        if (!binding.disposed && !disposed) {
          pruneInactiveBindings();
          publish();
        }
      });
    binding.hydrationOperation = operation;
    return operation;
  };

  const connectPhysicalHost = async (
    generation = lifecycleGeneration,
  ): Promise<void> => {
    ensureLifecycle(generation);
    const currentClient = requireClient();
    await currentClient.connect(config.initialize ?? defaultInitialize);
    ensureLifecycle(generation);
    clearReconnectTimer();
  };

  const restoreFileSystemWatches = async (): Promise<void> => {
    const currentClient = requireClient();
    // File watches are view accelerators, not part of the Host connection
    // critical path. A stale or temporarily unavailable path must not make an
    // otherwise healthy AppServer reconnect fail.
    await Promise.allSettled([...fileSystemWatches].map(([watchId, watch]) =>
      currentClient.request("fs/watch", { watchId, path: watch.path })
    ));
  };

  const initializeServices = (): Promise<void> => {
    if (disposed)
      return Promise.reject(new Error("AppServer Workbench is disposed"));
    if (client !== null && session !== null && commandPort !== null) {
      return Promise.resolve();
    }
    if (initializeServicesOperation !== null)
      return initializeServicesOperation;
    const generation = lifecycleGeneration;
    const operation = (async () => {
      ownedRegistry =
        config.clientRegistry === undefined
          ? await createCordisAppServerRegistry()
          : null;
      ensureLifecycle(generation);
      const clientRegistry = config.clientRegistry ?? ownedRegistry!.clients;
      client = clientRegistry.create({
        hostId,
        transport: config.transport,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      });
      terminalController = new AppServerTerminalController(hostId, client);
      removeFileSystemNotificationListener = client.subscribeNotification((notification) => {
        if (notification.method !== "fs/changed") return;
        const changed = notification.params as FsChangedNotification;
        const listener = fileSystemWatches.get(changed.watchId)?.listener;
        if (listener === undefined) return;
        try {
          listener(changed.changedPaths);
        } catch {
          // A panel listener is never allowed to break the Host notification
          // pump shared by every conversation on this connection.
        }
      });
      removeClientHandlers = config.installClientHandlers?.(client) ?? null;
      removeTransportListener = client.subscribeStatus((status) => {
        if (status.state === "open" || status.state === "connecting") {
          automaticReconnectBlock = null;
          loggedReconnectStopCode = null;
        }
        if (
          disposed ||
          status.state === "open" ||
          status.state === "connecting" ||
          status.state === "closing"
        )
          return;
        if (status.state === "closed" || status.state === "failed") {
          if (status.failure?.recovery === "manual") automaticReconnectBlock = status;
          console.log("[appserver-reconnect] transport-unavailable", { hostId, state: status.state });
          phase = status.failure?.recovery === "manual" ? "error" : "reconnecting";
          error = status.reason === undefined ? null : new Error(status.reason);
          for (const binding of bindings.values()) binding.replica.disconnect();
          publish();
          scheduleReconnect(status);
        }
      });
      await connectPhysicalHost(generation);
      ensureLifecycle(generation);
      session = await createCordisThreadSessionRuntime({
        client,
        hostKind:
          config.hostKind ?? (hostId === "durable" ? "durable" : "local"),
        supportsPaginatedHistory: true,
        useTailHydration: true,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      });
      ensureLifecycle(generation);
      interactions = new AppServerInteractionBroker({
        hostId,
        client,
        store: session.views,
      });
      fuzzyFileSearch = new AppServerFuzzyFileSearchController(client);
      commandPort = createAppServerConversationCommandPort({
        hostId,
        client,
        interactions,
        compiler: { historyMode: "paginated" },
        dynamicTools: config.dynamicTools,
      });
    })()
      .catch(async (cause) => {
        console.log("[appserver-runtime] service initialization failed", {
          hostId,
          errorType: cause instanceof Error ? cause.name : "Error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        removeTransportListener?.();
        removeTransportListener = null;
        removeClientHandlers?.();
        removeClientHandlers = null;
        removeFileSystemNotificationListener?.();
        removeFileSystemNotificationListener = null;
        interactions?.dispose();
        interactions = null;
        fuzzyFileSearch?.dispose();
        fuzzyFileSearch = null;
        await terminalController?.dispose().catch(() => undefined);
        terminalController = null;
        await session?.dispose().catch(() => undefined);
        session = null;
        if (ownedRegistry !== null) {
          await ownedRegistry.dispose().catch(() => undefined);
        } else {
          await config.clientRegistry?.remove(hostId).catch(() => undefined);
        }
        ownedRegistry = null;
        client = null;
        commandPort = null;
        throw cause;
      })
      .finally(() => {
        if (initializeServicesOperation === operation)
          initializeServicesOperation = null;
      });
    initializeServicesOperation = operation;
    return operation;
  };

  const runtime: AppServerWorkbenchRuntime = {
    resources: {
      host: {
        getConnectionGeneration() { return client?.connectionGeneration ?? 0; },
        getInitializeResult() {
          return client?.initializeResult ?? null;
        },
        fetchLoopback(input, init) {
          const transport = loopbackHttpTransport(config.transport);
          if (transport === null) {
            return Promise.reject(new Error(`Host ${hostId} does not provide loopback HTTP`));
          }
          return transport.fetchLoopback(input, init);
        },
      },
      threads: {
        async list(params = {}) {
          return requireClient().request("thread/list", {
            archived: false,
            cursor: null,
            limit: 30,
            sortDirection: "desc",
            sortKey: "updated_at",
            ...params,
          });
        },
        async start(options) {
          const params: ThreadStartParams = {
            cwd: options.cwd,
            runtimeWorkspaceRoots: [
              ...(options.runtimeWorkspaceRoots ?? [options.cwd]),
            ],
            historyMode: options.historyMode ?? "paginated",
            ...(options.model === undefined || options.model === "auto"
              ? {}
              : { model: options.model }),
            ...(options.projectId == null
              ? {}
              : { projectId: options.projectId }),
            ...(config.dynamicTools === undefined
              ? {}
              : { dynamicTools: [...config.dynamicTools] }),
          };
          const response = await requireClient().request(
            "thread/start",
            params,
          );
          return response.thread;
        },
      },
      projects: {
        async list(params = {}) {
          return requireClient().request("project/list", {
            cursor: null,
            limit: 100,
            ...params,
          });
        },
        async create(params) {
          return requireClient().request("project/create", params);
        },
      },
      fileSystem: {
        async getMetadata(path, signal) {
          return requireClient().request("fs/getMetadata", { path }, { signal });
        },
        async readFile(path, signal) {
          return requireClient().request("fs/readFile", { path }, { signal });
        },
        async readDirectory(path) {
          return requireClient().request("fs/readDirectory", { path });
        },
        async writeFile(path, dataBase64) {
          return requireClient().request("fs/writeFile", { path, dataBase64 });
        },
        async watch(path, listener) {
          const watchId = `opencraft:${hostId}:fs:${++fileSystemWatchSequence}`;
          fileSystemWatches.set(watchId, { path, listener });
          let response: FsWatchResponse;
          try {
            response = await requireClient().request("fs/watch", { watchId, path });
          } catch (error) {
            fileSystemWatches.delete(watchId);
            throw error;
          }
          let disposed = false;
          return {
            watchId,
            path: response.path,
            async dispose() {
              if (disposed) return;
              disposed = true;
              fileSystemWatches.delete(watchId);
              await requireClient().request("fs/unwatch", { watchId });
            },
          };
        },
        createFuzzyFileSearchSession(options) {
          if (fuzzyFileSearch === null) {
            return Promise.reject(
              new Error("AppServer fuzzy file search is unavailable"),
            );
          }
          return fuzzyFileSearch.createSession(options);
        },
      },
      composerCatalog: {
        async listAgents(params = {}) {
          return requireClient().request("agent/list", {
            cursor: null,
            limit: 100,
            ...params,
          });
        },
        async listModels(params = {}) {
          return requireClient().request("model/list", {
            cursor: null,
            limit: 100,
            includeHidden: false,
            ...params,
          });
        },
        async listPermissionProfiles(params = {}) {
          return requireClient().request("permissionProfile/list", {
            cursor: null,
            limit: 100,
            ...params,
          });
        },
        async listSkills(params = {}) {
          return requireClient().request("skills/list", {
            cwds: [],
            forceReload: false,
            ...params,
          });
        },
        createFuzzyFileSearchSession(options) {
          if (fuzzyFileSearch === null) {
            return Promise.reject(
              new Error("AppServer fuzzy file search is unavailable"),
            );
          }
          return fuzzyFileSearch.createSession(options);
        },
        subscribeSkillsChanged(listener) {
          return requireClient().subscribeNotification((notification) => {
            if (notification.method === "skills/changed") listener();
          });
        },
        subscribeAgentsChanged(listener) {
          return requireClient().subscribeNotification((notification) => {
            if (notification.method === "agent/catalog/updated") listener();
          });
        },
      },
      terminal: {
        attach(processId) {
          if (phase !== "ready" || terminalController === null) throw new Error("Terminal Host is not ready");
          return terminalController.attach(processId);
        },
        list() {
          if (phase !== "ready" || terminalController === null) throw new Error("Terminal Host is not ready");
          return terminalController.list();
        },
        open(options) {
          if (phase !== "ready") {
            throw new Error(`AppServer Host is not ready for a terminal (${phase})`);
          }
          if (terminalController === null) {
            throw new Error("AppServer terminal controller is unavailable");
          }
          return terminalController.open(options);
        },
      },
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("AppServer Workbench is disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      if (disposed)
        return Promise.reject(new Error("AppServer Workbench is disposed"));
      if (phase === "ready") return Promise.resolve();
      if (phase === "reconnecting")
        return reconnectOperation ?? runtime.reconnect();
      if (startOperation !== null) return startOperation;
      phase = "connecting";
      error = null;
      publish();
      const operation = (async () => {
        try {
          await initializeServices();
          phase = "ready";
          error = null;
          publish();
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause));
          phase = "error";
          publish();
          scheduleReconnect();
          throw cause;
        }
      })().finally(() => {
        if (startOperation === operation) startOperation = null;
      });
      startOperation = operation;
      return operation;
    },
    reconnect() {
      if (disposed)
        return Promise.reject(new Error("AppServer Workbench is disposed"));
      if (reconnectOperation !== null) return reconnectOperation;
      clearReconnectTimer();
      automaticReconnectBlock = null;
      loggedReconnectStopCode = null;
      const reconnectStartedAt = Date.now();
      const attempt = reconnectAttempt || 1;
      console.log("[appserver-reconnect] started", { hostId, attempt });
      phase = "reconnecting";
      error = null;
      publish();
      const generation = lifecycleGeneration;
      const operation = (async () => {
        try {
          await initializeServices();
          await connectPhysicalHost(generation);
          await terminalController?.reconnect();
          await restoreFileSystemWatches();
          ensureLifecycle(generation);
          const currentSession = requireSession();
          for (const binding of bindings.values()) {
            if (binding.disposed) continue;
            currentSession.resume.markNeedsResume(binding.threadId);
            await hydrateBinding(binding, true);
            ensureLifecycle(generation);
          }
          phase = "ready";
          error = null;
          clearReconnectTimer();
          reconnectAttempt = 0;
          console.log("[appserver-reconnect] succeeded", { hostId, attempt, elapsedMs: Date.now() - reconnectStartedAt });
          publish();
        } catch (cause) {
          console.log("[appserver-reconnect] failed", {
            hostId,
            attempt,
            errorType: cause instanceof Error ? cause.name : "Error",
            message: cause instanceof Error ? cause.message : String(cause),
            elapsedMs: Date.now() - reconnectStartedAt,
          });
          error = cause instanceof Error ? cause : new Error(String(cause));
          phase = "error";
          publish();
          scheduleReconnect(config.transport.status);
          throw cause;
        }
      })().finally(() => {
        if (reconnectOperation === operation) reconnectOperation = null;
      });
      reconnectOperation = operation;
      return operation;
    },
    async acquireThread(nextThreadId) {
      const threadId = requireThreadId(nextThreadId);
      await initializeServices();
      const binding = await createBinding(threadId);
      binding.retainCount += 1;
      touchBinding(binding);
      binding.phase =
        binding.hydrationOperation === null ? "resident" : binding.phase;
      publish();
      if (!binding.runtime.getSnapshot().authoritative) {
        // Acquisition does not wait on the network waterfall, but the V3 View
        // adapter must publish no persisted Timeline before Resume. The single
        // authoritative promotion happens after Resume + history settle.
        void hydrateBinding(binding, false).catch(() => undefined);
      }
      let released = false;
      return {
        threadId,
        getSnapshot: binding.runtime.getSnapshot,
        retryRestore() {
          if (released || binding.disposed) return Promise.reject(new Error(`Thread ${threadId} lease is released`));
          return hydrateBinding(binding, false);
        },
        subscribe(listener) {
          if (released || binding.disposed)
            throw new Error(`Thread ${threadId} lease is released`);
          binding.subscriberCount += 1;
          touchBinding(binding);
          publish();
          const remove = binding.runtime.subscribe(listener);
          let removed = false;
          return () => {
            if (removed) return;
            removed = true;
            remove();
            binding.subscriberCount = Math.max(0, binding.subscriberCount - 1);
            touchBinding(binding);
            pruneInactiveBindings();
            publish();
          };
        },
        submit: (intent) =>
          runBindingCommand(binding, async () => {
            const receipt = await binding.runtime.submit(intent);
            if (receipt.turnId !== null)
              retainAcceptedTurn(binding, receipt.turnId);
            return receipt;
          }),
        interrupt: (turnId) =>
          runBindingCommand(binding, () => binding.runtime.interrupt(turnId)),
        continueTurn: (turnId) =>
          runBindingCommand(binding, async () => {
            const receipt = await binding.runtime.continueTurn(turnId);
            if (receipt.turnId !== null)
              retainAcceptedTurn(binding, receipt.turnId);
            return receipt;
          }),
        respond: (response) =>
          runBindingCommand(binding, () => binding.runtime.respond(response)),
        updateQueuedSubmission: (queuedSubmissionId, input) =>
          runBindingCommand(binding, () =>
            binding.runtime.updateQueuedSubmission(queuedSubmissionId, input),
          ),
        deleteQueuedSubmission: (queuedSubmissionId) =>
          runBindingCommand(binding, () =>
            binding.runtime.deleteQueuedSubmission(queuedSubmissionId),
          ),
        reorderQueuedSubmissions: (queuedSubmissionIds) =>
          runBindingCommand(binding, () =>
            binding.runtime.reorderQueuedSubmissions(queuedSubmissionIds),
          ),
        startQueuedSubmission: (queuedSubmissionId) =>
          runBindingCommand(binding, async () => {
            const turnId =
              await binding.runtime.startQueuedSubmission(queuedSubmissionId);
            retainAcceptedTurn(binding, turnId);
            return turnId;
          }),
        steerQueuedSubmission: (queuedSubmissionId) =>
          runBindingCommand(binding, async () => {
            const turnId =
              await binding.runtime.steerQueuedSubmission(queuedSubmissionId);
            retainAcceptedTurn(binding, turnId);
            return turnId;
          }),
        loadOlder: () =>
          runBindingCommand(binding, () => binding.runtime.loadOlder()),
        getNavigation: () => binding.navigation,
        release() {
          if (released) return;
          released = true;
          binding.retainCount = Math.max(0, binding.retainCount - 1);
          touchBinding(binding);
          pruneInactiveBindings();
          publish();
        },
      } satisfies AppServerThreadRuntimeLease;
    },
    async createThread(intent) {
      if (intent.target.type !== "new-thread") {
        throw new Error(
          "Only a New chat Draft can create a Thread",
        );
      }
      if (intent.target.execution.hostId !== hostId) {
        throw new Error("This New chat Draft targets a different Host");
      }
      await initializeServices();
      if (commandPort === null)
        throw new Error("AppServer command port is unavailable");
      return commandPort.createThread(intent);
    },
    async submit(intent) {
      if (intent.target.type === "new-thread") return runtime.createThread(intent);
      throw new Error("Existing Thread commands require a View-owned Thread lease");
    },
    getThreadResidency(threadId) {
      const binding = bindings.get(threadId);
      return binding === undefined || binding.disposed
        ? null
        : residencySnapshot(binding);
    },
    dispose() {
      if (disposeOperation !== null) return disposeOperation;
      const operation = (async () => {
        if (disposed) return;
        clearReconnectTimer();
        phase = "disposed";
        error = null;
        publish();
        disposed = true;
        lifecycleGeneration += 1;
        removeTransportListener?.();
        removeTransportListener = null;
        removeClientHandlers?.();
        removeClientHandlers = null;
        removeFileSystemNotificationListener?.();
        removeFileSystemNotificationListener = null;

        const pending = [
          startOperation,
          reconnectOperation,
          initializeServicesOperation,
          ...bindingOperations.values(),
          ...[...bindings.values()].map(
            (binding) => binding.hydrationOperation,
          ),
        ].filter((candidate) => candidate !== null) as Promise<unknown>[];

        interactions?.dispose();
        interactions = null;
        fuzzyFileSearch?.dispose();
        fuzzyFileSearch = null;
        fileSystemWatches.clear();
        await terminalController?.dispose().catch(() => undefined);
        terminalController = null;
        await session?.dispose().catch(() => undefined);
        session = null;
        if (ownedRegistry !== null)
          await ownedRegistry.dispose().catch(() => undefined);
        else await config.clientRegistry?.remove(hostId).catch(() => undefined);
        await Promise.allSettled(pending);

        for (const binding of [...bindings.values()]) disposeBinding(binding);
        ownedRegistry = null;
        client = null;
        commandPort = null;
        listeners.clear();
      })();
      disposeOperation = operation;
      return operation;
    },
  };

  return runtime;
}
