import {
  AppServerClientError,
  createCordisAppServerRegistry,
  type AppServerClient,
  type AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import type {
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AttachmentRemoveResponse,
  AttachmentStageParams,
  AttachmentStageResponse,
  AttachmentStagingCapability,
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
  SteeringSubmission as ProtocolSteeringSubmission,
  ThreadStartParams,
  ThreadForkParams,
} from "@opencraft/appserver-protocol";
import {
  OPENCRAFT_ATTACHMENT_STAGING_EXTENSION,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
  OPENCRAFT_THREAD_GOAL_EXTENSION,
  OPENCRAFT_THREAD_LIFECYCLE_EXTENSION,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  parseAttachmentStagingCapability,
  parseThreadLifecycleCapability,
  supportsAtomicQueuedSteer,
  supportsUnconfirmedSteerDiscard,
  parseThreadGoalCapability,
} from "@opencraft/appserver-protocol";
import { OPENCRAFT_RESUME_HISTORY_EXTENSION } from "@opencraft/appserver-protocol";
import { reasoningCapability, modelInputModalities } from "@opencraft/composer-core";
import type {
  DynamicToolSpec,
  FsChangedNotification,
  FsGetMetadataResponse,
  FsWatchResponse,
  FsWriteFileResponse,
  ThreadQueueChangedNotification,
  Thread as ProtocolThread,
  ThreadInjectItemsParams,
  UserInput,
  ThreadGoal,
} from "@opencraft/appserver-protocol/generated/v2";
import { ThreadGoalResource } from "./thread-goal-resource";
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
  reconcileHydratedTurn,
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
  type TurnInterruptProvenance,
} from "@opencraft/chat-runtime";
import {
  AppServerFuzzyFileSearchController,
  AppServerInteractionBroker,
  AppServerInteractionLedger,
  createAppServerConversationCommandPort,
  type FuzzyFileSearchSession,
  type FuzzyFileSearchSessionOptions,
} from "@opencraft/composer-appserver";
import type { ModelSelectionPolicy, SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
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
  readonly modelSelectionPolicy?: ModelSelectionPolicy;
  /** Fixed transport for isolated runtimes and tests. A closed fixed transport is terminal. */
  readonly transport?: DuplexTransport;
  /** Creates one transport for each AppServer Client generation. */
  readonly createTransport?: () => DuplexTransport;
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

/** Count the model-callable definitions in an AppServer dynamic-tool catalog. */
export function countDynamicToolDefinitions(
  specs: readonly DynamicToolSpec[],
): number {
  return specs.reduce(
    (count, spec) => count + (spec.type === "namespace" ? spec.tools.length : 1),
    0,
  );
}

/**
 * A Thread capability registration is a scoped declaration lease, not
 * best-effort metadata. Display hydration may explicitly defer Engine mounting
 * while the Agent stays cold; partial registration is never valid. The Host
 * separately enforces exact mounting before execution admission.
 */
export function verifyDynamicToolRegistration(
  specs: readonly DynamicToolSpec[],
  result: { readonly registered: number; readonly deferred?: boolean },
  options: { readonly allowDeferred?: boolean } = {},
): void {
  const expected = countDynamicToolDefinitions(specs);
  if (
    result.registered !== expected
    && !(options.allowDeferred === true && result.deferred === true && result.registered === 0)
  ) {
    throw new Error(
      `Host registered ${result.registered} of ${expected} dynamic tools`,
    );
  }
}

export interface StartThreadOptions {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly projectId?: string | null;
  readonly model?: string;
  readonly historyMode?: "legacy" | "paginated";
  readonly agentId?: string;
  /** Host-advertised native profile ID; applied at Thread creation. */
  readonly permissions?: string;
}

export interface AppServerThreadResourcePort {
  capabilities?(): { fork: boolean; rename: boolean; archive: boolean; delete: boolean };
  rename?(threadId: string, name: string): Promise<void>;
  delete?(threadId: string): Promise<void>;
  archive?(threadId: string): Promise<void>;
  unarchive?(threadId: string): Promise<ProtocolThread>;
  injectItems?(threadId: string, items: ThreadInjectItemsParams["items"]): Promise<void>;
  supportsSideChat?(): boolean;
  list(params?: Partial<ThreadListParams>): Promise<ThreadListResponse>;
  start(options: StartThreadOptions): Promise<ProtocolThread>;
  fork?(params: ThreadForkParams): Promise<ProtocolThread>;
  unsubscribe?(threadId: string): Promise<void>;
}

export interface AppServerComposerCatalogResourcePort {
  listModels(params?: Partial<ModelListParams>): Promise<ModelListResponse>;
  readNewThreadDefaults(cwd?: string | null): Promise<{
    readonly model: string | null;
    readonly effort: string | null;
  }>;
  writeNewThreadDefaults(defaults: {
    readonly model: string;
    readonly effort: string | null;
  }): Promise<void>;
  listPermissionProfiles(
    params?: Partial<PermissionProfileListParams>,
  ): Promise<PermissionProfileListResponse>;
  listSkills(params?: Partial<SkillsListParams>): Promise<SkillsListResponse>;
  createFuzzyFileSearchSession(
    options: FuzzyFileSearchSessionOptions,
  ): Promise<FuzzyFileSearchSession>;
  subscribeSkillsChanged(listener: () => void): () => void;
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

/** Raw protocol access after this runtime has completed AppServer initialize. */
export interface AppServerProtocolResourcePort {
  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<AppServerMethodResult<TMethod>>;
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

export interface AppServerAttachmentResourcePort {
  capabilities(): AttachmentStagingCapability | null;
  stage(
    params: AttachmentStageParams,
    signal?: AbortSignal,
  ): Promise<AttachmentStageResponse>;
  remove(id: string): Promise<AttachmentRemoveResponse>;
}

export interface AppServerFileWatchLease {
  readonly watchId: string;
  readonly path: string;
  dispose(): Promise<void>;
}

export interface AppServerWorkbenchRuntime {
  readonly resources: {
    readonly protocol: AppServerProtocolResourcePort;
    readonly host: AppServerHostResourcePort;
    readonly threads: AppServerThreadResourcePort;
    readonly projects: AppServerProjectResourcePort;
    readonly fileSystem: AppServerFileSystemResourcePort;
    readonly attachments: AppServerAttachmentResourcePort;
    readonly goals: ThreadGoalResource;
    readonly composerCatalog: AppServerComposerCatalogResourcePort;
    readonly terminal: AppServerTerminalResourcePort;
  };
  getSnapshot(): AppServerWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects the Host. It never chooses or restores a Thread. */
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  acquireThread(threadId: string): Promise<AppServerThreadRuntimeLease>;
  /**
   * Creates the recoverable submission boundary declared by the Host. Most
   * Hosts return after Thread creation; first-Turn durable Hosts return only
   * after that Turn is accepted.
   */
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
  interrupt(turnId: TurnId, provenance?: TurnInterruptProvenance): Promise<void>;
  continueTurn(turnId: TurnId): Promise<SubmissionReceipt>;
  respond(response: InteractionResponse): Promise<void>;
  updateQueuedSubmission(
    queuedSubmissionId: string,
    input: readonly UserInput[],
  ): Promise<void>;
  deleteQueuedSubmission(queuedSubmissionId: string): Promise<void>;
  discardUnconfirmedSteer(queuedSubmissionId: string, expectedTurnId: TurnId): Promise<void>;
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
  hydrationConnectionRevision: number;
  capabilityRegistrationOperation: Promise<void> | null;
  capabilityRegistrationClient: AppServerClient | null;
  capabilityRegistrationGeneration: number | null;
  capabilityDeclarationAccepted: boolean;
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
    extensions: {},
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
  if ((config.transport === undefined) === (config.createTransport === undefined)) {
    throw new TypeError("AppServer Workbench requires exactly one transport ownership mode");
  }
  const hostId = asHostId(config.hostId);
  const clock = config.clock ?? defaultClock;
  const reconnectDelays = config.reconnectDelaysMs ?? [
    250, 500, 1_000, 2_000, 5_000,
  ];
  const maxInactiveThreads = config.maxInactiveThreads ?? 4;
  const listeners = new Set<() => void>();
  const skillsChangedListeners = new Set<() => void>();
  const bindings = new Map<string, ConversationBinding>();
  const interactionLedger = new AppServerInteractionLedger();
  const ephemeralThreadIds = new Set<string>();
  // Acknowledged durable forks can precede Codex's first child-Turn catalog entry.
  const unlistedForks = new Map<string, ProtocolThread>();
  const forkOperations = new Map<string, Promise<ProtocolThread>>();
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
  let connectionRevision = 0;
  const resourceRetryTimers = new Map<ConversationBinding, unknown>();
  let automaticReconnectBlock: TransportStatus | null = null;
  let loggedReconnectStopCode: string | null = null;
  let logicalClock = 0;
  let ownedRegistry: Awaited<
    ReturnType<typeof createCordisAppServerRegistry>
  > | null = null;
  let currentTransport: DuplexTransport | null = config.createTransport === undefined
    ? config.transport ?? null
    : null;
  let client: AppServerClient | null = null;
  let session: CordisThreadSessionRuntime | null = null;
  let interactions: AppServerInteractionBroker | null = null;
  let fuzzyFileSearch: AppServerFuzzyFileSearchController | null = null;
  let commandPort: ReturnType<
    typeof createAppServerConversationCommandPort
  > | null = null;
  let terminalController: AppServerTerminalController | null = null;
  let removeTransportListener: (() => void) | null = null;
  let removeRecoveryHintListener: (() => void) | null = null;
  let removeClientHandlers: (() => void) | null = null;
  let removeFileSystemNotificationListener: (() => void) | null = null;
  let removeSkillsNotificationListener: (() => void) | null = null;
  let removeGoalNotificationListener: (() => void) | null = null;
  const goals = new ThreadGoalResource({
    capability: () => parseThreadGoalCapability(client?.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_GOAL_EXTENSION]),
    get: (threadId) => requireClient().request("thread/goal/get", { threadId }),
    set: (threadId, change) => requireClient().request("thread/goal/set", { threadId, ...change }),
    clear: (threadId) => requireClient().request("thread/goal/clear", { threadId }),
  });
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
    // Manual failure belongs to the Host attempt, not the disposed transport.
    transport: automaticReconnectBlock ?? client?.status ?? currentTransport?.status ?? { state: "idle" },
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
    const effectiveStatus = automaticReconnectBlock
      ?? transportStatus
      ?? currentTransport?.status
      ?? { state: "idle" };
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
    const retry = resourceRetryTimers.get(binding);
    if (retry !== undefined) clock.clearTimeout(retry);
    resourceRetryTimers.delete(binding);
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

  /**
   * Dynamic tools are an execution capability lease, not Conversation history.
   * Keep one registration flight per physical client generation so visible
   * hydration can commit independently while every mutation reuses the same
   * readiness boundary.
   */
  const ensureBindingCapabilities = (
    binding: ConversationBinding,
  ): Promise<void> => {
    const currentClient = requireClient();
    const dynamicTools = config.dynamicTools;
    if (
      dynamicTools === undefined
      || currentClient.initializeResult?.capabilities?.extensions?.["opencraft/host-capabilities"] === undefined
    ) return Promise.resolve();
    const generation = currentClient.connectionGeneration;
    const sameGeneration = binding.capabilityRegistrationClient === currentClient
      && binding.capabilityRegistrationGeneration === generation;
    if (sameGeneration && binding.capabilityDeclarationAccepted) return Promise.resolve();
    if (sameGeneration && binding.capabilityRegistrationOperation !== null) {
      return binding.capabilityRegistrationOperation;
    }

    binding.capabilityRegistrationClient = currentClient;
    binding.capabilityRegistrationGeneration = generation;
    binding.capabilityDeclarationAccepted = false;
    const operation = currentClient.request("runtime/capabilities/register", {
      threadId: binding.threadId,
      dynamicTools,
    }).then((registration) => {
      if (
        disposed
        || binding.disposed
        || client !== currentClient
        || currentClient.connectionGeneration !== generation
      ) throw new Error(`Dynamic-tool registration expired for Thread ${binding.threadId}`);
      verifyDynamicToolRegistration(dynamicTools, registration, {
        allowDeferred: true,
      });
      binding.capabilityDeclarationAccepted = true;
    }).finally(() => {
      if (
        binding.capabilityRegistrationClient === currentClient
        && binding.capabilityRegistrationGeneration === generation
        && binding.capabilityRegistrationOperation === operation
      ) binding.capabilityRegistrationOperation = null;
    });
    binding.capabilityRegistrationOperation = operation;
    return operation;
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
      const afterAuthoritativeBaseline = async <T>(operation: () => Promise<T>, requiresCapabilities = false): Promise<T> => {
        const owner = bindings.get(threadId);
        if (owner === undefined || owner.disposed) {
          throw new Error(`Thread ${threadId} is unavailable`);
        }
        // A local optimistic Item may paint immediately, but no AppServer
        // mutation may overtake the Thread's initial Resume. Otherwise a
        // concurrently completing snapshot and the live notification stream
        // can each publish the first user message, and a backend such as
        // Hermes cannot reconcile them because durable history has no client
        // message identity. Session owns the baseline: Resume for persisted
        // threads, adopted fork response for ephemeral side conversations.
        if (!owner.runtime.getSnapshot().authoritative) {
          await hydrateBinding(owner, false);
        }
        if (requiresCapabilities) await ensureBindingCapabilities(owner);
        return operation();
      };
      const baselineGatedCommands: ConversationCommandPort = {
        ...currentCommandPort,
        submit: (intent) => afterAuthoritativeBaseline(() => currentCommandPort.submit(intent), true),
        interrupt: (key, turnId, provenance) => afterAuthoritativeBaseline(
          () => currentCommandPort.interrupt(key, turnId, provenance),
        ),
        continueTurn: (key, turnId) => afterAuthoritativeBaseline(() => currentCommandPort.continueTurn(key, turnId), true),
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
          () => currentCommandPort.startQueuedSubmission(key, id), true,
        ),
        steerQueuedSubmission: (key, submission, activeTurnId) => afterAuthoritativeBaseline(
          () => currentCommandPort.steerQueuedSubmission(key, submission, activeTurnId), true,
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
            commitHydratedTurn: (turn, chronologicalTurnIds, baselineTurn) => {
              const committedView = currentSession.views.update(
                threadId,
                (current) => ({
                  ...current,
                  turns: reconcileHydratedTurn(current.turns, turn, chronologicalTurnIds, { turn: baselineTurn }),
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
        hydrationConnectionRevision: connectionRevision,
        capabilityRegistrationOperation: null,
        capabilityRegistrationClient: null,
        capabilityRegistrationGeneration: null,
        capabilityDeclarationAccepted: false,
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
            const steering: ProtocolSteeringSubmission[] = [];
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
              steering.push(...(page.steering ?? []));
              cursor = page.nextCursor;
            } while (cursor !== null);
            if (!disposed && !binding.disposed) {
              conversation!.replaceQueuedSubmissions(submissions, steering);
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
      if (!ephemeralThreadIds.has(threadId)) void refreshQueue().catch(() => undefined);
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
    retryRejected = false,
  ): Promise<void> => {
    if (binding.disposed)
      return Promise.reject(
        new Error(`Thread ${binding.threadId} is disposed`),
      );
    if (binding.hydrationOperation !== null) {
      if (binding.hydrationConnectionRevision === connectionRevision && (!force || binding.hydrationForReconnect))
        return binding.hydrationOperation;
      return binding.hydrationOperation
        .catch(() => undefined)
        .then(() => hydrateBinding(binding, true, retryRejected));
    }
    binding.hydrationForReconnect = force;
    const revision = connectionRevision;
    binding.hydrationConnectionRevision = revision;
    const current = () => !disposed && !binding.disposed && revision === connectionRevision;
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
          if (ephemeralThreadIds.has(binding.threadId)) {
            const view = currentSession.views.get(binding.threadId);
            if (view?.resumeState !== "resumed" || view.connectionGeneration !== requireClient().connectionGeneration) {
              throw new Error("This temporary side chat expired after disconnect. Start a new side chat.");
            }
          } else await currentSession.resume.resume({ threadId: binding.threadId, force, retryRejected });
          if (!current()) throw new AppServerClientError("ABORTED", "Thread recovery was superseded");
          // Prewarm execution readiness, but do not keep already-restored
          // history behind a slow connector/tool registration request.
          void ensureBindingCapabilities(binding).catch(() => undefined);
        } finally { stopPreview(); }
        const source = createCodexThreadReplicaSource(
          currentSession.views,
          hostId,
          binding.threadId,
        );
        await binding.replica.synchronize(source);
        if (!current()) return;
        binding.phase = "resident";
        touchBinding(binding);
      })
      .catch((cause) => {
        if (current()) {
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

  // Resource restoration is not part of Host readiness. A missing Thread
  // must not reconnect the Host or delay another Thread's restoration.
  const restoreResources = () => {
    const revision = connectionRevision;
    const current = () => !disposed && revision === connectionRevision && phase === "ready";
    void terminalController?.reconnect().catch(() => undefined);
    void restoreFileSystemWatches().catch(() => undefined);
    const pending = [...bindings.values()].filter(binding => !binding.disposed)
      .sort((a, b) => b.retainCount - a.retainCount || b.touchedAt - a.touchedAt);
    const restore = async (binding: ConversationBinding, attempt = 0): Promise<void> => {
      if (!current() || binding.disposed) return;
      try {
        requireSession().resume.markNeedsResume(binding.threadId);
        await hydrateBinding(binding, true);
      } catch (cause) {
        if (!current() || binding.disposed) return;
        // Semantic errors need a local retry/user decision, not endless traffic.
        if (!(cause instanceof AppServerClientError) || !["TIMEOUT", "QUEUE_FULL", "TRANSPORT_ERROR", "NOT_CONNECTED"].includes(cause.code)) return;
        if (resourceRetryTimers.has(binding)) return;
        resourceRetryTimers.set(binding, clock.setTimeout(() => {
          resourceRetryTimers.delete(binding);
          void restore(binding, attempt + 1);
        }, reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 5_000));
      }
    };
    const worker = async () => {
      while (current()) {
        const binding = pending.shift();
        if (!binding) return;
        await restore(binding);
      }
    };
    const workerCount = Math.min(4, pending.length);
    for (let index = 0; index < workerCount; index++) void worker();
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
    let attemptTransport: DuplexTransport | null = null;
    const operation = (async () => {
      ownedRegistry =
        config.clientRegistry === undefined
          ? await createCordisAppServerRegistry()
          : null;
      ensureLifecycle(generation);
      const clientRegistry = config.clientRegistry ?? ownedRegistry!.clients;
      attemptTransport = config.createTransport?.() ?? config.transport ?? null;
      if (attemptTransport === null) {
        throw new Error("AppServer transport factory did not create a transport");
      }
      currentTransport = attemptTransport;
      client = clientRegistry.create({
        hostId,
        transport: attemptTransport,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      });
      terminalController = new AppServerTerminalController(hostId, client);
      removeSkillsNotificationListener = client.subscribeNotification((notification) => {
        if (notification.method !== "skills/changed") return;
        for (const listener of skillsChangedListeners) {
          try { listener(); } catch { /* One View cannot break the shared notification pump. */ }
        }
      });
      removeGoalNotificationListener = client.subscribeNotification((notification) => {
        if (notification.method === "thread/goal/updated") {
          const params = notification.params as { threadId: string; goal: ThreadGoal };
          goals.observe(params.threadId, params.goal);
        } else if (notification.method === "thread/goal/cleared") {
          const params = notification.params as { threadId: string };
          goals.observe(params.threadId, null);
        }
      });
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
          connectionRevision += 1;
          for (const timer of resourceRetryTimers.values()) clock.clearTimeout(timer);
          resourceRetryTimers.clear();
          if (status.failure?.recovery === "manual") automaticReconnectBlock = status;
          console.log("[appserver-reconnect] transport-unavailable", { hostId, state: status.state });
          phase = status.failure?.recovery === "manual" ? "error" : "reconnecting";
          error = status.reason === undefined ? null : new Error(status.reason);
          for (const binding of bindings.values()) binding.replica.disconnect();
          publish();
          scheduleReconnect(status);
        }
      });
      removeRecoveryHintListener = currentTransport?.subscribeRecoveryHint?.(() => {
        if (disposed || config.autoReconnect === false || automaticReconnectBlock?.failure?.recovery === "manual") return;
        if (phase !== "ready" && startOperation === null && reconnectOperation === null) {
          void runtime.reconnect().catch(() => undefined);
        }
      }) ?? null;
      await connectPhysicalHost(generation);
      ensureLifecycle(generation);
      goals.reset();
      const resumeHistoryCapability = client.initializeResult?.capabilities?.extensions?.[
        OPENCRAFT_RESUME_HISTORY_EXTENSION
      ] as { version?: unknown; mode?: unknown } | undefined;
      const historyModeHint = resumeHistoryCapability?.version === 1
        && ["legacy", "paginated", "message-window"].includes(String(resumeHistoryCapability.mode))
        ? resumeHistoryCapability.mode as "legacy" | "paginated" | "message-window"
        : null;
      session = await createCordisThreadSessionRuntime({
        client,
        hostKind:
          config.hostKind ?? (hostId === "durable" ? "durable" : "local"),
        supportsPaginatedHistory: true,
        historyModeHint,
        useTailHydration: true,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      });
      ensureLifecycle(generation);
      interactions = new AppServerInteractionBroker({
        hostId,
        client,
        ledger: interactionLedger,
        store: session.views,
      });
      fuzzyFileSearch = new AppServerFuzzyFileSearchController(client);
      commandPort = createAppServerConversationCommandPort({
        hostId,
        client,
        interactions,
        queueAtomicSteer: supportsAtomicQueuedSteer(
          client.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_QUEUE_EXTENSION],
        ),
        queueUnconfirmedSteerDiscard: supportsUnconfirmedSteerDiscard(
          client.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_QUEUE_EXTENSION],
        ),
        compiler: { historyMode: "paginated" },
        modelSelectionPolicy: config.modelSelectionPolicy,
        resolveCompilerOptions: async (intent) => {
          const followUp = intent.target.type === "steer-active-turn" || intent.target.type === "enqueue-follow-up";
          const threadId = intent.target.type === "new-thread" ? null : intent.target.key.threadId;
          const useHostDefault = config.modelSelectionPolicy === "host-default" && !followUp;
          const modelId = useHostDefault ? null : intent.selections.model ?? (threadId ? bindings.get(threadId)?.runtime.getSnapshot().execution.model : null);
          const scope = !useHostDefault && client!.initializeResult?.capabilities?.extensions?.[OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION] !== undefined ? threadId : null;
          let cursor: string | null = null;
          const seen = new Set<string>();
          do {
            const page: ModelListResponse = await client!.request("model/list", {cursor,limit:100,includeHidden:false,...(scope ? {threadId:scope} : {})});
            const model = page.data.find(model => modelId ? model.id === modelId || model.model === modelId : model.isDefault);
            if (model) {
              const inputModalities = modelInputModalities(model.inputModalities);
              if (followUp) return { inputModalities };
              // The Host owns reasoning settings in embedded mode as well.
              if (useHostDefault) return { inputModalities, model: model.model };
              return {
                inputModalities,
                ...(!modelId ? { model: model.model } : {}),
                reasoning: reasoningCapability(
                  model.supportedReasoningEfforts.map(e => e.reasoningEffort),
                  model.defaultReasoningEffort,
                ),
              };
            }
            cursor = page.nextCursor;
            if (cursor) { if (seen.has(cursor)) throw new Error("模型目录分页重复"); seen.add(cursor); }
          } while (cursor);
          throw new Error(useHostDefault ? "当前 Bot 未配置可用的默认模型，请在模型设置中检查" : modelId ? "所选模型已不可用，请重新选择" : "请先选择模型或在设置中指定默认模型");
        },
        dynamicTools: config.dynamicTools,
        onInterrupt: (event) => console.info("[turn-interrupt] client request", event),
      });
    })()
      .catch(async (cause) => {
        console.log("[appserver-runtime] service initialization failed", {
          hostId,
          errorType: cause instanceof Error ? cause.name : "Error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        if (config.createTransport === undefined) {
          // Registry cleanup closes a fixed transport permanently. It has no
          // factory-backed successor, so an automatic retry would only spin
          // on the disposed object forever.
          clearReconnectTimer();
          automaticReconnectBlock ??= {
            state: "closed",
            reason: "The fixed AppServer transport generation was closed after initialization failed",
            failure: { code: "fixed-transport-generation-closed", recovery: "manual" },
          };
        }
        removeTransportListener?.();
        removeTransportListener = null;
        removeRecoveryHintListener?.();
        removeRecoveryHintListener = null;
        removeClientHandlers?.();
        removeClientHandlers = null;
        removeFileSystemNotificationListener?.();
        removeFileSystemNotificationListener = null;
        removeSkillsNotificationListener?.();
        removeSkillsNotificationListener = null;
        removeGoalNotificationListener?.();
        removeGoalNotificationListener = null;
        interactions?.dispose();
        interactions = null;
        fuzzyFileSearch?.dispose();
        fuzzyFileSearch = null;
        await terminalController?.dispose().catch(() => undefined);
        terminalController = null;
        await session?.dispose().catch(() => undefined);
        session = null;
        const failedClient = client;
        if (ownedRegistry !== null) {
          await ownedRegistry.dispose().catch(() => undefined);
        } else if (failedClient !== null) {
          await config.clientRegistry?.remove(hostId).catch(() => undefined);
        } else {
          await attemptTransport?.close().catch(() => undefined);
        }
        if (currentTransport === attemptTransport) currentTransport = null;
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
      protocol: {
        request(method, params) {
          return requireClient().request(method, params);
        },
      },
      goals,
      host: {
        getConnectionGeneration() { return client?.connectionGeneration ?? 0; },
        getInitializeResult() {
          return client?.initializeResult ?? null;
        },
        async fetchLoopback(input, init) {
          const transport = currentTransport === null
            ? null
            : loopbackHttpTransport(currentTransport);
          if (transport === null) {
            const client = requireClient();
            if (!client.initializeResult?.capabilities?.extensions?.["opencraft/loopback-http"]) throw new Error(`Host ${hostId} does not provide loopback HTTP`);
            const requestId = crypto.randomUUID();
            let bodyBase64: string | undefined;
            if (init?.body != null) {
              const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
              let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
              bodyBase64 = btoa(binary);
            }
            const abort = () => { void client.request("runtime/http/cancel", { requestId }).catch(() => {}); };
            if (init?.signal?.aborted) throw new Error("Loopback HTTP request cancelled");
            init?.signal?.addEventListener("abort", abort, { once: true });
            try {
              const result = await client.request("runtime/http/request", { requestId, url: input,
                method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), bodyBase64 }, { signal: init?.signal ?? undefined });
              const body = Uint8Array.from(atob(result.bodyBase64), char => char.charCodeAt(0));
              return new Response([101, 204, 205, 304].includes(result.status) || init?.method === "HEAD" ? null : body,
                { status: result.status, statusText: result.statusText, headers: result.headers });
            } finally { init?.signal?.removeEventListener("abort", abort); }
          }
          return transport.fetchLoopback(input, init);
        },
      },
      threads: {
        capabilities() {
          const capability = parseThreadLifecycleCapability(client?.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION]);
          return { fork: capability?.fork === true, rename: capability?.rename === true, archive: capability?.archive === true, delete: capability?.delete === true };
        },
        async rename(threadId, name) { await requireClient().request("thread/name/set", { threadId, name }); },
        async delete(threadId) { await requireClient().request("thread/delete", { threadId }); },
        async archive(threadId) { await requireClient().request("thread/archive", { threadId }); },
        async unarchive(threadId) { return (await requireClient().request("thread/unarchive", { threadId })).thread as ProtocolThread; },
        supportsSideChat() {
          const capability = parseThreadLifecycleCapability(requireClient().initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION]);
          return capability?.fork === true && capability.ephemeral === true && capability.injectItems === true && capability.unsubscribe === true;
        },
        async injectItems(threadId, items) {
          await requireClient().request("thread/inject_items", { threadId, items: [...items] });
        },
        async fork(params) {
          const forkKey = JSON.stringify(params);
          const existing = params.ephemeral === true ? undefined : forkOperations.get(forkKey);
          if (existing) return existing;
          const operation = (async () => {
            const currentClient = requireClient();
            const generation = currentClient.connectionGeneration;
            const response = await currentClient.request("thread/fork", params, { timeoutMs: 0 });
            if (client !== currentClient || generation !== currentClient.connectionGeneration) {
              throw new AppServerClientError("TRANSPORT_ERROR", "Fork response belongs to an earlier Host generation");
            }
            if (params.ephemeral === true) {
              requireSession().resume.adoptFork(response, generation);
              ephemeralThreadIds.add(response.thread.id);
            } else {
              unlistedForks.set(response.thread.id, { ...response.thread, turns: [] });
            }
            return response.thread;
          })();
          if (params.ephemeral !== true) {
            forkOperations.set(forkKey, operation);
            const clear = () => { if (forkOperations.get(forkKey) === operation) forkOperations.delete(forkKey); };
            void operation.then(clear, clear);
          }
          return operation;
        },
        async unsubscribe(threadId) {
          const binding = bindings.get(threadId);
          if (binding && binding.retainCount > 0) throw new Error("Cannot unsubscribe a thread with active consumers");
          const currentClient = requireClient(), generation = lifecycleGeneration, connectionGeneration = currentClient.connectionGeneration;
          await currentClient.request("thread/unsubscribe", { threadId });
          if (disposed || generation !== lifecycleGeneration || client !== currentClient || currentClient.connectionGeneration !== connectionGeneration) return;
          const current = bindings.get(threadId);
          if (current && (current !== binding || hasHardResidencyReason(current))) {
            // The unsubscribe won on the wire; the new consumer must actually
            // reattach, not merely retain a stale local projection.
            requireSession().resume.markNeedsResume(threadId);
            await requireSession().resume.resume({ threadId, force: true });
            await hydrateBinding(current, false);
            return;
          }
          if (current) disposeBinding(current);
          ephemeralThreadIds.delete(threadId);
          requireSession().views.remove(threadId);
        },
        async list(params = {}) {
          const response = await requireClient().request("thread/list", {
            archived: false,
            cursor: null,
            limit: 30,
            sortDirection: "desc",
            sortKey: "updated_at",
            ...params,
          });
          const defaultCatalog = Object.keys(params).every(key => key === "cursor" || key === "limit")
            && params.cursor == null;
          if (defaultCatalog && unlistedForks.size > 0) {
            const listed = new Set(response.data.map(thread => thread.id));
            for (const id of listed) unlistedForks.delete(id);
            const missing = [...unlistedForks.values()];
            if (missing.length > 0) {
              response.data = [...missing, ...response.data]
                .sort((left, right) => right.updatedAt - left.updatedAt);
            }
          }
          const views = requireSession().views;
          for (const thread of response.data) views.seedMetadata(thread);
          return response;
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
            ...(options.permissions === undefined
              ? {}
              : { permissions: options.permissions }),
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
      attachments: {
        capabilities() {
          const advertised = client?.initializeResult?.capabilities?.extensions?.[
            OPENCRAFT_ATTACHMENT_STAGING_EXTENSION
          ];
          return advertised === undefined
            ? null
            : parseAttachmentStagingCapability(advertised);
        },
        async stage(params, signal) {
          const capability = runtime.resources.attachments.capabilities();
          if (capability === null) {
            throw new Error(`Host ${hostId} does not provide attachment staging`);
          }
          if (!capability.sources.includes(params.source.kind)) {
            throw new Error(`Host ${hostId} does not accept ${params.source.kind} attachments`);
          }
          if (params.size > capability.maxBytes) {
            throw new Error(`Attachment exceeds ${capability.maxBytes} bytes`);
          }
          return requireClient().request("attachment/stage", params, { signal });
        },
        async remove(id) {
          return requireClient().request("attachment/remove", { id });
        },
      },
      composerCatalog: {
        async listModels(params = {}) {
          return requireClient().request("model/list", {
            cursor: null,
            limit: 100,
            includeHidden: false,
            ...params,
          });
        },
        async readNewThreadDefaults(cwd = null) {
          const response = await requireClient().request("config/read", {
            includeLayers: false,
            ...(cwd === null ? {} : { cwd }),
          });
          return {
            model: typeof response.config.model === "string"
              ? response.config.model
              : null,
            effort: typeof response.config.model_reasoning_effort === "string"
              ? response.config.model_reasoning_effort
              : null,
          };
        },
        async writeNewThreadDefaults(defaults) {
          await requireClient().request("config/batchWrite", {
            edits: [
              { keyPath: "model", value: defaults.model, mergeStrategy: "replace" },
              { keyPath: "model_reasoning_effort", value: defaults.effort, mergeStrategy: "replace" },
            ],
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
          if (disposed) throw new Error("AppServer Workbench is disposed");
          skillsChangedListeners.add(listener);
          return () => { skillsChangedListeners.delete(listener); };
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
      automaticReconnectBlock = null;
      loggedReconnectStopCode = null;
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
          ensureLifecycle(generation);
          if (currentTransport?.status.state !== "open" || client?.initializeResult == null) {
            throw new AppServerClientError("NOT_CONNECTED", "Host disconnected during initialization");
          }
          phase = "ready";
          error = null;
          clearReconnectTimer();
          reconnectAttempt = 0;
          console.log("[appserver-reconnect] succeeded", { hostId, attempt, elapsedMs: Date.now() - reconnectStartedAt });
          publish();
          restoreResources();
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
          scheduleReconnect(currentTransport?.status);
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
          return hydrateBinding(binding, false, true);
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
        interrupt: (turnId, provenance) =>
          runBindingCommand(binding, () => binding.runtime.interrupt(turnId, provenance)),
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
        discardUnconfirmedSteer: (queuedSubmissionId, expectedTurnId) =>
          runBindingCommand(binding, () =>
            binding.runtime.discardUnconfirmedSteer(queuedSubmissionId, expectedTurnId),
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
      const durability = client?.initializeResult?.capabilities?.extensions?.[
        OPENCRAFT_THREAD_START_DURABILITY_EXTENSION
      ] as { version?: unknown; durableAfter?: unknown } | undefined;
      return durability?.version === 1
        && durability.durableAfter === "first-turn-accepted"
        ? commandPort.submit(intent)
        : commandPort.createThread(intent);
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
        connectionRevision += 1;
        for (const timer of resourceRetryTimers.values()) clock.clearTimeout(timer);
        resourceRetryTimers.clear();
        phase = "disposed";
        error = null;
        publish();
        disposed = true;
        lifecycleGeneration += 1;
        removeTransportListener?.();
        removeTransportListener = null;
        removeRecoveryHintListener?.();
        removeRecoveryHintListener = null;
        removeClientHandlers?.();
        removeClientHandlers = null;
        removeFileSystemNotificationListener?.();
        removeFileSystemNotificationListener = null;
        removeSkillsNotificationListener?.();
        removeSkillsNotificationListener = null;
        removeGoalNotificationListener?.();
        removeGoalNotificationListener = null;
        skillsChangedListeners.clear();

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
        interactionLedger.clear();
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
        currentTransport = null;
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
