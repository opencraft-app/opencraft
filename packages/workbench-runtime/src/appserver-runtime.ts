import { ThreadOrchestrationResource } from "./thread-orchestration-resource";
import { executionEngineExtension } from "@opencraft/appserver-client";
import { TURN_RECOVERY_EXTENSION } from "@opencraft/appserver-protocol";
import { ThreadRecoveryResource } from "./thread-recovery-resource";
import { SCOPED_SKILL_CATALOG_EXTENSION, SCOPED_SKILL_CATALOG_METHOD, type ScopedSkillsListParams } from "@opencraft/appserver-protocol";
import type { HostComposerCommandPort } from "./host-composer-commands";
import { MCP_APPS_NAMESPACE } from "@opencraft/appserver-protocol/mcp-apps";
import type { ConversationOutboxStorage } from "@opencraft/chat-runtime";
import { ConnectionLifecycleOwner, type ConnectionAttempt } from "./connection-lifecycle";
import { recoveryNow } from "./recovery-clock";
import { ConversationRecoveryOwner, type RecoveryDemand } from "./recovery-policy";
import {
  AppServerClientError,
  AppServerRpcError,
  threadUnavailableReason,
  isRetryableAppServerRpcError,
  type ThreadUnavailableReason,
  createCordisAppServerRegistry,
  type AppServerClient,
  type AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import type {
  MessageSender,
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AttachmentRemoveResponse,
  AttachmentUploadParams,
  AttachmentUploadResponse,
  AttachmentStageParams,
  AttachmentStageResponse,
  AttachmentStagingCapability,
  ModelListParams,
  ModelListResponse,
  PermissionProfileListParams,
  PermissionProfileListResponse,
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
  OPENCRAFT_THREAD_PINS_EXTENSION,
  supportsThreadPinDiscovery,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  parseAttachmentStagingCapability,
  parseThreadLifecycleCapability,
  supportsAtomicQueuedSteer,
  supportsUnconfirmedSteerDiscard,
  parseThreadGoalCapability,
  allowsAppServerMethod,
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
import { ThreadPinningResource } from "./thread-pinning-resource";
import {
  ReplicaClient,
  type ReplicaClientStorage,
} from "@opencraft/appserver-replica";
import {
  threadViewReplicaScope,
  createV3ConversationNavigationSource,
  createThreadViewReplicaSource,
  createCordisThreadSessionRuntime,
  createThreadViewReplicaProjectionBarrier,
  reconcileHydratedTurn,
  projectThreadViewForReplica,
  type AppServerHostKind,
  type CordisThreadSessionRuntime,
  type ThreadViewFrameScheduler,
} from "@opencraft/appserver-session";
import {
  asHostId,
  createConversationKey,
  type HostId,
  type TurnId,
} from "@opencraft/chat-core";
import {
  createReplicaConversationRuntime,
  createConversationOutbox,
  type ConversationOutbox,
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
  readonly recovery?: import("./recovery-observation").RecoveryProgress;
}

export interface AppServerWorkbenchSnapshot {
  readonly revision: number;
  readonly phase: AppServerWorkbenchPhase;
  readonly hostId: HostId;
  readonly connectionGeneration: number;
  readonly transport: TransportStatus;
  readonly recovery?: import("./recovery-observation").RecoveryProgress;
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
  wallNow?(): number;
  now?(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface SelectableModelPresentation {
  readonly id: string;
  readonly displayName: string;
  readonly groupKey: string | null;
  readonly groupLabel: string | null;
  readonly configuredRole?: "primary" | "fallback" | null;
}

export interface AppServerWorkbenchRuntimeConfig {
  readonly outbox?: ConversationOutboxStorage;
  readonly hostId: string;
  /** Presentation-only identity captured when a local message is submitted. */
  readonly getSubmissionSender?: () => MessageSender | null;
  readonly canDispatchOutbox?: () => boolean;
  readonly modelSelectionPolicy?: ModelSelectionPolicy;
  /** Composition-owned availability and display projection; the Host still authorizes execution. */
  readonly readSelectableModels?: (catalog: readonly { readonly id: string; readonly model: string }[], options?: { readonly preferCached?: boolean }) => Promise<readonly SelectableModelPresentation[] | null>;
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
  /** Reset retry escalation only after a continuously ready connection. */
  readonly reconnectStableMs?: number;
  readonly maxInactiveThreads?: number;
  readonly maxInactiveThreadBytes?: number;
  readonly maxCachedThreadMetadata?: number;
  readonly clock?: AppServerRuntimeClock;
  readonly dynamicTools?: readonly DynamicToolSpec[];
  readonly onRecoveryEvent?: (event: Readonly<Record<string, string | number>>) => void;
  /** Installs host-scoped server-request handlers before initialize. */
  readonly installClientHandlers?: (client: AppServerClient) => () => void;
  /** Application-owned multi-Host Cordis registry. Omit for isolated tests. */
  readonly clientRegistry?: Pick<
    AppServerClientRegistryService,
    "create" | "remove"
  >;
  readonly frameScheduler?: ThreadViewFrameScheduler;
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
  getUnavailableReason?(threadId: string): ThreadUnavailableReason | null;
  subscribeUnavailable?(listener: (threadId: string, reason: ThreadUnavailableReason) => void): () => void;
  capabilities?(threadId?: string): { fork: boolean; rename: boolean; archive: boolean; delete: boolean; pin?: boolean; reference?: boolean };
  setPinned?(threadId: string, pinned: boolean): Promise<void>;
  rename?(threadId: string, name: string): Promise<void>;
  delete?(threadId: string): Promise<void>;
  archive?(threadId: string): Promise<void>;
  unarchive?(threadId: string): Promise<ProtocolThread>;
  injectItems?(threadId: string, items: ThreadInjectItemsParams["items"]): Promise<void>;
  supportsSideChat?(threadId?: string): boolean;
  list(params?: Partial<ThreadListParams>): Promise<ThreadListResponse>;
  start(options: StartThreadOptions): Promise<ProtocolThread>;
  fork?(params: ThreadForkParams): Promise<ProtocolThread>;
  unsubscribe?(threadId: string): Promise<void>;
}

export interface AppServerComposerCatalogResourcePort {
  listModels(params?: Partial<ModelListParams>): Promise<ModelListResponse>;
  readNewThreadDefaults(cwd?: string | null): Promise<{
    readonly serviceTier?: string | null;
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
  listSkills(params?: ScopedSkillsListParams): Promise<SkillsListResponse>;
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
  subscribeSchedulesChanged?(listener: () => void): () => void;
  getInitializeResult(): AppServerInitializeResponse | null;
  /** Bridge admission only; native rejection still remains authoritative. */
  canRequest?(method: AppServerMethod): boolean;
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
    options?: import("@opencraft/appserver-protocol").AppServerRequestOptions,
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
  uploadChunk(params: AttachmentUploadParams): Promise<AttachmentUploadResponse>;
  uploadCancel(uploadId: string): Promise<{ removed: boolean }>;
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
    readonly composerCommands?: HostComposerCommandPort;
    readonly protocol: AppServerProtocolResourcePort;
    readonly host: AppServerHostResourcePort;
    readonly threads: AppServerThreadResourcePort;
    readonly projects: AppServerProjectResourcePort;
    readonly fileSystem: AppServerFileSystemResourcePort;
    readonly attachments: AppServerAttachmentResourcePort;
    readonly goals: ThreadGoalResource;
    readonly turnRecovery: ThreadRecoveryResource;
    readonly orchestration: ThreadOrchestrationResource;
    readonly composerCatalog: AppServerComposerCatalogResourcePort;
    readonly terminal: AppServerTerminalResourcePort;
  };
  getSnapshot(): AppServerWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects the Host. It never chooses or restores a Thread. */
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  acquireThread(threadId: string): Promise<AppServerThreadRuntimeLease>;
  /** Local input only; this creates no Client, Thread lease or execution authority. */
  localOutbox?(threadId: string): ConversationOutbox | null;
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
  setRecoveryVisibility(visible: boolean): void;
  readonly threadId: string;
  getSnapshot(): ConversationRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry this Thread's baseline without navigating or reconnecting its Host. */
  retryRestore(): Promise<void>;
  /** Read durable message-window history without Resume or execution ownership changes. */
  refreshHistory(signal?: AbortSignal): Promise<boolean>;
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
  readonly projectionCache: WeakMap<object, ReplicaJsonValue>;
  readonly runtime: ConversationRuntime;
  readonly navigation: ConversationNavigationSource;
  removeRuntimeListener: () => void;
  removeLiveViewListener: () => void;
  removeQueueListener: () => void;
  queueRefreshOperation: Promise<void> | null;
  queueRefreshRequested: boolean;
  refreshQueue: () => Promise<void>;
  retainCount: number;
  visibleCount: number;
  touchedAt: number;
  hydrationOperation: Promise<void> | null;
  cancelHydration: (() => void) | null;
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
  now: recoveryNow,
  wallNow: () => Date.now(),
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
  const maxInactiveThreads = config.maxInactiveThreads ?? 4;
  const listeners = new Set<() => void>();
  const schedulesChangedListeners = new Set<() => void>();
  const skillsChangedListeners = new Set<() => void>();
  const bindings = new Map<string, ConversationBinding>();
  const catalogMetadata = new Map<string, ProtocolThread>();
  const interactionLedger = new AppServerInteractionLedger();
  const ephemeralThreadIds = new Set<string>();
  // Acknowledged durable forks can precede their first child-Turn catalog entry.
  const unlistedForks = new Map<string, ProtocolThread>();
  const forkOperations = new Map<string, Promise<ProtocolThread>>();
  const bindingOperations = new Map<string, Promise<ConversationBinding>>();
  const pendingViewAcquires = new Map<string, number>();
  const detachOperations = new Map<string, Promise<void>>();
  const failedReadDetaches = new Map<string, { client: AppServerClient; generation: number }>();
  let detachRetryTimer: unknown | null = null;
  let detachRetryDelayMs = 15_000;
  let revision = 0;
  let phase: AppServerWorkbenchPhase = "idle";
  let error: Error | null = null;
  let disposed = false;
  let lifecycleGeneration = 0;
  let disposeOperation: Promise<void> | null = null;
  let initializeServicesOperation: Promise<void> | null = null;
  let connectionRevision = 0;
  let connectionObservation: { client: AppServerClient; revision: number; attempt?: ConnectionAttempt } | null = null;
  const recovery = new ConversationRecoveryOwner({ hostId, clock,
    delaysMs: config.reconnectDelaysMs,
    jitter: config.clock === undefined,
    log: config.onRecoveryEvent ? event => config.onRecoveryEvent!({
      ...event, generation: client?.connectionGeneration ?? 0, eventAtMs: clock.wallNow?.() ?? clock.now?.() ?? Date.now(), ...((currentTransport?.status as {attemptId?:string}|undefined)?.attemptId ? {attemptId:(currentTransport!.status as {attemptId?:string}).attemptId} : {}),
    }) : undefined, changed: () => publish(),
  });
  let automaticReconnectBlock: TransportStatus | null = null;
  // Presentation only: initialization cleanup must not erase the failed attempt ID.
  let initializationFailureStatus: TransportStatus | null = null;
  let logicalClock = 0;
  let ownedRegistry: Awaited<
    ReturnType<typeof createCordisAppServerRegistry>
  > | null = null;
  let currentTransport: DuplexTransport | null = config.createTransport === undefined
    ? config.transport ?? null
    : null;
  let client: AppServerClient | null = null;
  let threadPins: { client: AppServerClient; generation: number; resource: ThreadPinningResource } | null = null;
  const pinResource = (current: AppServerClient) => {
    const generation = current.connectionGeneration;
    if (!threadPins || threadPins.client !== current || threadPins.generation !== generation) {
      threadPins = { client: current, generation, resource: new ThreadPinningResource({
        current: () => client === current && current.connectionGeneration === generation && current.status.state === "open",
        read: () => current.request("opencraft/thread-pins/list", {}),
        write: (threadId, pinned) => current.request("opencraft/thread-pins/set", { threadId, pinned }),
      }) };
    }
    return threadPins.resource;
  };
  let session: CordisThreadSessionRuntime | null = null;
  const unavailableThreads = new Map<string, { reason: ThreadUnavailableReason; error: AppServerRpcError }>();
  const availabilityRevisions = new Map<string, number>();
  const unavailableListeners = new Set<(threadId: string, reason: ThreadUnavailableReason) => void>();
  let interactions: AppServerInteractionBroker | null = null;
  let fuzzyFileSearch: AppServerFuzzyFileSearchController | null = null;
  let commandPort: ReturnType<
    typeof createAppServerConversationCommandPort
  > | null = null;
  let terminalController: AppServerTerminalController | null = null;
  let removeTransportListener: (() => void) | null = null;
  let removeRecoveryHintListener: (() => void) | null = null;
  let removeRecoveryMetrics: (() => void) | null = null;
  let removeClientHandlers: (() => void) | null = null;
  let removeFileSystemNotificationListener: (() => void) | null = null;
  let removeSkillsNotificationListener: (() => void) | null = null;
  let removeGoalNotificationListener: (() => void) | null = null;
  const goals = new ThreadGoalResource({
    capability: threadId => parseThreadGoalCapability(executionEngineExtension(client?.initializeResult?.capabilities?.extensions, threadId, OPENCRAFT_THREAD_GOAL_EXTENSION)),
    get: (threadId) => requireClient().request("thread/goal/get", { threadId }),
    set: (threadId, change) => requireClient().request("thread/goal/set", { threadId, ...change }),
    clear: (threadId) => requireClient().request("thread/goal/clear", { threadId }),
  });
  const turnRecovery = new ThreadRecoveryResource({
    supported: threadId => executionEngineExtension(client?.initializeResult?.capabilities?.extensions, threadId, TURN_RECOVERY_EXTENSION)?.version === 1,
    read: threadId => requireClient().request("opencraft/turn-recovery/read", { threadId }),
  });
  const orchestration = new ThreadOrchestrationResource({
    supported: () => (client?.initializeResult?.capabilities?.extensions?.["opencraft/thread-orchestration-view"] as {version?:unknown} | undefined)?.version === 1,
    read: (threadId,calls) => requireClient().request("opencraft/collaboration",{action:"orchestration",threadId,calls}),
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
      (pendingViewAcquires.get(binding.threadId) ?? 0) > 0 ||
      binding.retainCount > 0 ||
      binding.subscriberCount > 0 ||
      binding.runtime.getSnapshot().queuedSubmissions.some(item => item.local) ||
      binding.pendingCommandCount > 0 ||
      binding.acceptedTurnIds.size > 0 ||
      activity.activeStreamCount > 0 ||
      activity.pendingInteractionCount > 0 ||
      binding.hydrationOperation !== null
      // An ephemeral fork has no durable restore source. Its explicit owner
      // closes it through unsubscribe; a cache budget cannot destroy it.
      || ephemeralThreadIds.has(binding.threadId)
    );
  };

  const transportSnapshot = (): TransportStatus => {
    const status = automaticReconnectBlock ?? client?.status ?? currentTransport?.status
      ?? initializationFailureStatus ?? { state: "idle" };
    // Admission revokes the previous attempt's diagnostics synchronously,
    // even while that attempt still owns its physical cleanup. A failure in
    // the current attempt is published only after the owner leaves attempting.
    if (error === null && (phase === "connecting" || phase === "reconnecting")
      && (status.state === "closed" || status.state === "failed")) return { state: "connecting" };
    return status;
  };

  const derive = (): AppServerWorkbenchSnapshot => ({
    revision,
    phase,
    hostId,
    connectionGeneration: client?.connectionGeneration ?? 0,
    // Manual failure belongs to the Host attempt, not the disposed transport.
    transport: transportSnapshot(),
    recovery: recovery.getProgress(),
    residentThreads: [...bindings.values()]
      .filter((binding) => !binding.disposed)
      .map(binding => ({ ...residencySnapshot(binding), recovery: recovery.getProgress(binding) })),
    error,
  });
  snapshot = derive();

  const publish = () => {
    if (disposed) return;
    const next = derive();
    const sameResidency = next.residentThreads.length === snapshot.residentThreads.length
      && next.residentThreads.every((entry, index) => {
        const previous = snapshot.residentThreads[index]!;
        return (Object.keys(entry) as (keyof ThreadRuntimeResidencySnapshot)[])
          .every(key => entry[key] === previous[key]);
      });
    if (next.recovery === snapshot.recovery && next.phase === snapshot.phase && next.error === snapshot.error
      && next.connectionGeneration === snapshot.connectionGeneration
      && next.transport.state === snapshot.transport.state
      && next.transport.attemptId === snapshot.transport.attemptId
      && next.transport.reason === snapshot.transport.reason
      && next.transport.failure === snapshot.transport.failure && sameResidency) return;
    revision += 1;
    snapshot = { ...next, revision };
    for (const listener of listeners) listener();
  };

  type ConnectionBinding = { client: AppServerClient; transport: DuplexTransport; generation: number; revision: number };
  const connection = new ConnectionLifecycleOwner<ConnectionBinding>({
    clock, autoReconnect: config.autoReconnect, delaysMs: config.reconnectDelaysMs,
    jitter: config.clock === undefined,
    stableMs: config.reconnectStableMs, timeoutMs: Math.max(60_000, (config.requestTimeoutMs ?? 30_000) + 15_000),
    async run(attempt: ConnectionAttempt) {
      // Assembly settles on revocation. Retired bundles clean only their own
      // resources in the background; they cannot hold a successor's admission.
      attempt.progress("services");
      if (initializeServicesOperation !== null) await initializeServicesOperation.catch(() => undefined);
      attempt.assertCurrent();
      automaticReconnectBlock = null;
      initializationFailureStatus = null;
      await initializeServices(attempt);
      attempt.assertCurrent();
      return connectPhysicalHost(lifecycleGeneration, attempt);
    },
    valid: binding => !disposed && binding.client === client && binding.transport === currentTransport
      && binding.revision === connectionRevision && binding.generation === client.connectionGeneration
      && client.initializeResult !== null && currentTransport.status.state === "open",
    manual: () => (automaticReconnectBlock ?? currentTransport?.status)?.failure?.recovery === "manual",
    invalidate() {
      connectionRevision += 1;
      connectionObservation = null;
      // Clear all authority before recovery observers can reenter the Runtime.
      for (const binding of bindings.values()) { binding.cancelHydration?.(); binding.replica.disconnect(); }
      recovery.invalidate();
    },
    changed() {
      const state = connection.snapshot;
      phase = state.phase === "attempting" ? state.recovering ? "reconnecting" : "connecting"
        : state.phase === "usable" ? "ready"
        : state.phase === "backoff" ? "reconnecting"
        : state.phase === "blocked" ? "error" : state.phase;
      error = state.error;
      if (state.phase === "attempting") {
        connectionObservation = null;
        recovery.begin("connecting");
      }
      else if (state.phase === "usable") recovery.hostReady();
      else if (state.phase === "blocked") { recovery.connectionFailed(state.error); recovery.connectionBlocked(); }
      else if (state.phase === "backoff") recovery.connectionFailed(state.error);
      publish();
    },
    backoff: (attempt, delayMs) => recovery.connectionBackoff(attempt, delayMs),
    usable: () => { if (bindings.size > 0) restoreResources(); },
  });

  const requireClient = (): AppServerClient => {
    if (client === null) throw new Error("AppServer Workbench has not started");
    return client;
  };

  const listSelectableModels = async (params: ModelListParams): Promise<ModelListResponse> => {
    const page = await requireClient().request("model/list", params);
    if (!config.readSelectableModels) return page;
    const choices = new Map((await config.readSelectableModels(page.data) ?? []).map((choice) => [choice.id, choice]));
    return { ...page, data: page.data.flatMap((model) => {
      const choice = choices.get(model.id);
      return choice ? [{ ...model, displayName: choice.displayName,
        groupKey: choice.groupKey, groupLabel: choice.groupLabel,
        configuredRole: choice.configuredRole ?? null }] : [];
    }) };
  };

  const canRequest = (method: AppServerMethod): boolean => allowsAppServerMethod(
    client?.initializeResult?.capabilities?.extensions, method,
  );
  const assertMethodAccess = (method: AppServerMethod): void => {
    if (!canRequest(method)) throw new Error("此连接暂不支持该操作");
  };

  const requireSession = (): CordisThreadSessionRuntime => {
    if (session === null) throw new Error("AppServer Session has not started");
    return session;
  };

  const disposeBinding = (binding: ConversationBinding) => {
    recovery.remove(binding);
    binding.cancelHydration?.();
    if (binding.disposed) return;
    binding.phase = "disposing";
    binding.disposed = true;
    bindings.delete(binding.threadId);
    binding.removeRuntimeListener();
    binding.removeLiveViewListener();
    binding.removeQueueListener();
    binding.navigation.dispose();
    binding.runtime.dispose();
    binding.replica.dispose();
    binding.phase = "disposed";
  };

  const retryReadDetaches = () => {
    if (disposed || failedReadDetaches.size === 0 || detachRetryTimer !== null) return;
    detachRetryTimer = clock.setTimeout(() => {
      detachRetryTimer = null;
      const pending = [...failedReadDetaches];
      failedReadDetaches.clear();
      for (const [threadId, owner] of pending) {
        if (client !== owner.client || client.connectionGeneration !== owner.generation || client.status.state !== "open") continue;
        if (bindings.has(threadId) || bindingOperations.has(threadId)) continue;
        detachReader(threadId, owner.client);
      }
      detachRetryDelayMs = Math.min(detachRetryDelayMs * 2, 60_000);
    }, detachRetryDelayMs);
  };
  const detachReader = (threadId: string, owner: AppServerClient) => {
    const generation = owner.connectionGeneration;
    const operation = owner.request("thread/unsubscribe", { threadId })
      .then(() => undefined, () => {
        if (!disposed && client === owner && owner.connectionGeneration === generation && owner.status.state === "open") {
          failedReadDetaches.set(threadId, { client: owner, generation });
          // Never log an RPC error payload or silently lose a failed cleanup.
          console.warn("[appserver-residency] read-detach-retry-scheduled", { hostId });
          retryReadDetaches();
        }
      }).finally(() => {
        if (detachOperations.get(threadId) === operation) detachOperations.delete(threadId);
      });
    detachOperations.set(threadId, operation);
  };

  const contentSizes = new WeakMap<object, number>();
  const contentSize = (value: unknown): number => {
    if (typeof value === "string") return value.length * 2;
    if (value === null || typeof value !== "object") return 8;
    const cached = contentSizes.get(value);
    if (cached !== undefined) return cached;
    let bytes = 32;
    for (const [key, child] of Object.entries(value)) bytes += key.length * 2 + contentSize(child);
    contentSizes.set(value, bytes);
    return bytes;
  };
  const pruneInactiveBindings = () => {
    const inactive = [...bindings.values()]
      .filter((binding) => !hasHardResidencyReason(binding))
      .sort((left, right) => left.touchedAt - right.touchedAt);
    for (const binding of inactive) binding.phase = "evictable";
    const sizes = new Map(inactive.map((binding) => [binding, contentSize(requireSession().views.get(binding.threadId))]));
    let inactiveBytes = [...sizes.values()].reduce((total, bytes) => total + bytes, 0);
    while (inactive.length > maxInactiveThreads || inactiveBytes > (config.maxInactiveThreadBytes ?? 64 * 1024 * 1024)) {
      const binding = inactive.shift();
      if (!binding) break;
      inactiveBytes -= sizes.get(binding) ?? 0;
      disposeBinding(binding);
      const currentSession = requireSession();
      currentSession.resume.release(binding.threadId);
      const currentClient = requireClient();
      const capability = parseThreadLifecycleCapability(
        currentClient.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION],
      );
      if (capability?.unsubscribe && canRequest("thread/unsubscribe") && currentClient.status.state === "open") {
        // Send before another acquire can resume. A new consumer waits for
        // this read-attachment transaction, never races it with new commands.
        detachReader(binding.threadId, currentClient);
      }
    }
    for (const binding of bindings.values()) {
      if (binding.phase === "evictable" && hasHardResidencyReason(binding)) {
        binding.phase = "resident";
      }
    }
  };

  let residencyPublicationQueued = false;
  const scheduleResidencyPublication = () => {
    if (residencyPublicationQueued) return;
    residencyPublicationQueued = true;
    globalThis.queueMicrotask(() => {
      residencyPublicationQueued = false;
      if (disposed) return;
      pruneInactiveBindings();
      publish();
    });
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
  const declaredDynamicTools = () => config.dynamicTools?.filter(tool =>
    tool.type !== "namespace" || tool.name !== MCP_APPS_NAMESPACE
    || client?.initializeResult?.capabilities?.extensions?.["opencraft/mcp-app-builder"] !== undefined);
  const ensureBindingCapabilities = (
    binding: ConversationBinding,
  ): Promise<void> => {
    const currentClient = requireClient();
    const dynamicTools = declaredDynamicTools();
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

  // Optional reads cannot create their own residency demand. A retained View or
  // observer may still use them after another lease leaves; execution has its
  // separate command/accepted-Turn/stream owners.
  const retireUnobservedHistory = (binding: ConversationBinding) => {
    if (binding.retainCount === 0 && binding.subscriberCount === 0
      && (pendingViewAcquires.get(binding.threadId) ?? 0) === 0)
      session?.resume.cancelDerivedHistory(binding.threadId);
  };

  const runBindingCommand = async <T>(
    binding: ConversationBinding,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (binding.disposed)
      throw new Error(`Thread ${binding.threadId} is disposed`);
    session?.views.flush(binding.threadId);
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
    await detachOperations.get(threadId);
    failedReadDetaches.delete(threadId);
    if (failedReadDetaches.size === 0 && detachRetryTimer !== null) {
      clock.clearTimeout(detachRetryTimer); detachRetryTimer = null; detachRetryDelayMs = 15_000;
    }
    const existing = bindings.get(threadId);
    if (existing !== undefined) return existing;
    const currentSession = requireSession();
    const metadata = catalogMetadata.get(threadId);
    if (metadata !== undefined) currentSession.views.seedMetadata(metadata);
    const currentClient = requireClient();
    if (commandPort === null)
      throw new Error("AppServer command port is unavailable");
    const currentCommandPort = commandPort;
    const replica = new ReplicaClient<ReplicaJsonValue>({
      scope: threadViewReplicaScope(hostId, threadId),
      storageKey: storageKey(hostId, threadId),
      storage: volatileThreadViewReplicaStorage,
      pageSize: config.pageSize ?? 100,
    });
    let conversation: ConversationRuntime | null = null;
    let navigation: ConversationNavigationController | null = null;
    try {
      await replica.prepare();
      const afterAuthoritativeBaseline = async <T>(operation: (canDispatch: () => boolean) => Promise<T>, requiresCapabilities = false): Promise<T> => {
        const owner = bindings.get(threadId);
        if (!owner) throw new Error(`Thread ${threadId} is unavailable`);
        const assertOwner = () => {
          if (owner.disposed || bindings.get(threadId) !== owner)
            throw new Error(`Thread ${threadId} is unavailable`);
        };
        assertOwner();
        for (;;) {
          const revision = connectionRevision;
          let awaitedHistory: Promise<void> | null = null;
          try {
            if (phase !== "ready") await runtime.connect();
            assertOwner();
            if (!owner.runtime.getSnapshot().authoritative) {
              awaitedHistory = hydrateBinding(owner, false);
              await awaitedHistory;
              awaitedHistory = null;
            }
            if (connectionRevision !== revision || !owner.runtime.getSnapshot().authoritative) continue;
            if (requiresCapabilities) {
              await requireSession().resume.activate({ threadId, retryRejected: true });
              if (connectionRevision !== revision || !owner.runtime.getSnapshot().authoritative) continue;
              await ensureBindingCapabilities(owner);
            }
          } catch (cause) {
            // Only preparation has run. Following a superseded local read is
            // safe; a command already passed to its port is never retried here.
            const replacedRead = awaitedHistory !== null && owner.hydrationOperation !== awaitedHistory;
            if ((connectionRevision !== revision || replacedRead) && !owner.disposed && bindings.get(threadId) === owner
              && cause instanceof AppServerClientError && cause.code === "ABORTED") continue;
            throw cause;
          }
          assertOwner();
          const dispatchClient = requireClient(), generation = dispatchClient.connectionGeneration;
          const canDispatch = () => !owner.disposed && bindings.get(threadId) === owner
            && phase === "ready" && connection.snapshot.phase === "usable"
            && client === dispatchClient && generation === dispatchClient.connectionGeneration
            && connectionRevision === revision && dispatchClient.status.state === "open"
            && owner.runtime.getSnapshot().authoritative;
          if (!canDispatch()) continue;
          return operation(canDispatch);
        }
      };
      const afterCurrentHost = async <T>(operation: (canDispatch: () => boolean) => Promise<T>): Promise<T> => {
        const owner = bindings.get(threadId);
        if (!owner || owner.disposed) throw new Error(`Thread ${threadId} is unavailable`);
        if (phase !== "ready") await runtime.connect();
        const dispatchClient = requireClient(), generation = dispatchClient.connectionGeneration;
        // A known-target control needs current Host/connection ownership.
        // Presentation revision and historical authority are separate owners.
        const canDispatch = () => !disposed && !owner.disposed && bindings.get(threadId) === owner
          && phase === "ready" && connection.snapshot.phase === "usable" && !unavailableThreads.has(threadId)
          && client === currentClient && client === dispatchClient
          && generation === dispatchClient.connectionGeneration && dispatchClient.status.state === "open";
        if (!canDispatch()) throw new AppServerClientError("NOT_CONNECTED", "The connection changed before the response could be stopped");
        return operation(canDispatch);
      };
      const baselineGatedCommands: ConversationCommandPort = {
        ...currentCommandPort,
        submit: (intent, options) => afterAuthoritativeBaseline(canDispatch => {
          const followUp = executionEngineExtension(currentClient.initializeResult?.capabilities?.extensions, threadId, "opencraft/thread-follow-up");
          const dispatched = intent.target.type === "enqueue-follow-up" && followUp?.queue === false
            ? { ...intent, target: { type: "existing-thread" as const, key: intent.target.key } } : intent;
          return currentCommandPort.submit(dispatched, { ...options, canDispatch: () => (options?.canDispatch() ?? true) && canDispatch() });
        }, true),
        interrupt: (key, turnId, provenance, options) => afterCurrentHost(canDispatch => currentCommandPort.interrupt(key, turnId, provenance, {
          canDispatch: () => (options?.canDispatch() ?? true) && canDispatch(),
        })),
        continueTurn: (key, turnId) => afterAuthoritativeBaseline(() => currentCommandPort.continueTurn(key, turnId), true),
        // The Broker validates the exact native request context. Historical
        // authority cannot grant or revoke its already-admitted reply channel.
        respond: (key, response) => currentCommandPort.respond(key, response),
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
        localOutbox: localOutbox(threadId) ?? undefined,
        canDispatchOutbox: (intent) => config.canDispatchOutbox?.() !== false && phase === "ready" && connection.snapshot.phase === "usable" && currentTransport?.status.state === "open"
          && (intent?.target.type === "steer-active-turn"
            || executionEngineExtension(currentClient.initializeResult?.capabilities?.extensions, threadId, "opencraft/thread-follow-up")?.queue !== false
            || !conversation?.getSnapshot().activeTurn),
        canAutoContinueCapacity: () => currentClient.initializeResult?.capabilities?.extensions?.["opencraft/capacity-retry"] === undefined,
        getSubmissionSender: config.getSubmissionSender,
        key: createConversationKey(hostId, threadId),
        replica,
        commands: baselineGatedCommands,
        history: {
          loadOlder: async () => {
            try { await currentSession.resume.loadOlder(threadId); }
            catch (error) {
              // Local history retirement is normal navigation/recovery, not a
              // cached history failure for the next View.
              if (!(error instanceof AppServerClientError && error.code === "ABORTED")) throw error;
            }
          },
        },
      });
      const projectionBarrier =
        createThreadViewReplicaProjectionBarrier(replica);
      navigation = new ConversationNavigationController(
        createV3ConversationNavigationSource({
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
        projectionCache: new WeakMap(),
        runtime: conversation,
        navigation,
        removeRuntimeListener: () => undefined,
        removeLiveViewListener: () => undefined,
        removeQueueListener: () => undefined,
        queueRefreshOperation: null,
        queueRefreshRequested: false,
        refreshQueue: () => Promise.resolve(),
        retainCount: 0,
        visibleCount: 0,
        touchedAt: ++logicalClock,
        hydrationOperation: null,
        cancelHydration: null,
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
      let liveView = currentSession.views.get(threadId);
      binding.removeLiveViewListener = currentSession.views.subscribeThread(threadId, () => {
        const view = currentSession.views.get(threadId), previous = liveView;
        liveView = view;
        if (!view || binding.disposed || session !== currentSession || client !== currentClient) return;
        const value = projectThreadViewForReplica(view, binding.projectionCache);
        const retained = binding.replica.get(threadId);
        if (!retained || typeof retained !== "object" || Array.isArray(retained)
          || typeof value !== "object" || !value || Array.isArray(value) || !("execution" in value)) {
          binding.replica.reportPreview(threadId, value);
          return;
        }
        // A native interaction/settings update is visible before (and after a
        // failed) history read. Retained transcript, cursor and revision remain
        // owned by their baseline; this paint cannot grant history authority.
        binding.replica.reportPreview(threadId, { ...retained,
          ...(previous?.execution !== view.execution ? { execution: value.execution } : {}),
          pendingInteractions: value.pendingInteractions,
        });
      });
      let previousActivity = bindingActivity(binding);
      binding.removeRuntimeListener = conversation.subscribe(() => {
        if (binding.disposed) return;
        const previousAcceptedCount = binding.acceptedTurnIds.size;
        const previousPhase = binding.phase;
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
        if (binding.phase !== "hydrating" && binding.phase !== "reconnecting" && binding.phase !== "error") {
          binding.phase = hasHardResidencyReason(binding)
            ? "resident"
            : "evictable";
        }
        const activity = bindingActivity(binding);
        const residencyChanged = activity.activeStreamCount !== previousActivity.activeStreamCount
          || activity.pendingInteractionCount !== previousActivity.pendingInteractionCount
          || activity.authoritative !== previousActivity.authoritative
          || binding.acceptedTurnIds.size !== previousAcceptedCount
          || binding.phase !== previousPhase;
        previousActivity = activity;
        if (residencyChanged) {
          // A text delta belongs to the Conversation subscription, not Host
          // connection/catalog state. Prune after the observer stack unwinds.
          scheduleResidencyPublication();
        }
      });
      const refreshQueue = (): Promise<void> => {
        if (!canRequest("thread/queue/list") || executionEngineExtension(currentClient.initializeResult?.capabilities?.extensions, threadId, "opencraft/thread-follow-up")?.queue === false) return Promise.resolve();
        if (binding.queueRefreshOperation !== null) {
          binding.queueRefreshRequested = true;
          return binding.queueRefreshOperation;
        }
        const operation = (async () => {
          do {
            binding.queueRefreshRequested = false;
            const queueGeneration = currentClient.connectionGeneration;
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
            // A change notification received during this read invalidates its
            // snapshot. Publish only the next complete read, keeping the current
            // queue visible while it refreshes (including optimistic additions).
            if (!disposed && !binding.disposed && client === currentClient
              && queueGeneration === currentClient.connectionGeneration && !binding.queueRefreshRequested) {
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
            if (binding.queueRefreshRequested && !disposed && !binding.disposed && phase === "ready")
              void refreshQueue().catch(() => undefined);
          }
        });
        binding.queueRefreshOperation = operation;
        return operation;
      };
      binding.refreshQueue = refreshQueue;
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

  const markThreadUnavailable = (threadId: string, reason: ThreadUnavailableReason, cause?: AppServerRpcError) => {
    const failure = cause ?? new AppServerRpcError({ code: reason === "archived" ? -32071 : -32600,
      message: reason === "archived" ? "Thread is archived" : "Thread not found" });
    unavailableThreads.set(threadId, { reason, error: failure });
    availabilityRevisions.set(threadId, (availabilityRevisions.get(threadId) ?? 0) + 1);
    const binding = bindings.get(threadId);
    if (binding) {
      recovery.remove(binding);
      binding.cancelHydration?.();
      binding.phase = "error";
      binding.replica.disconnect();
      session?.resume.markNeedsResume(threadId);
      binding.replica.reportSyncFailure(failure);
    }
    for (const listener of unavailableListeners) {
      try { listener(threadId, reason); } catch { /* Selection observers cannot affect the Host. */ }
    }
    publish();
  };
  const markThreadAvailable = (threadId: string) => {
    // Native restoration and its ACK describe one transition. A duplicate must
    // not retire the current recovery or manufacture another availability epoch.
    if (!unavailableThreads.delete(threadId)) return;
    const revision = (availabilityRevisions.get(threadId) ?? 0) + 1;
    availabilityRevisions.set(threadId, revision);
    session?.resume.clearResumeRejection(threadId);
    session?.resume.markNeedsResume(threadId);
    const binding = bindings.get(threadId);
    const current = () => !disposed && phase === "ready" && binding !== undefined && !binding.disposed
      && bindings.get(threadId) === binding && availabilityRevisions.get(threadId) === revision
      && !unavailableThreads.has(threadId);
    if (binding && current()) {
      void recovery.recover({ key: binding, demand: () => current() ? recoveryDemand(binding) : "cache",
        run: signal => current() ? hydrateBinding(binding, false, true, undefined, signal) : Promise.resolve(),
        retryable: cause => current() && retryableHistoryFailure(cause),
      }, true).catch(() => undefined);
    }
    publish();
  };

  const captureHistoryCheckpoint = (binding: ConversationBinding) => {
    const snapshot = binding.runtime.getSnapshot();
    return {
      session,
      revision: connectionRevision,
      checkpoint: snapshot.authoritative && snapshot.activeTurn === null
        && binding.pendingCommandCount === 0 && binding.acceptedTurnIds.size === 0
        ? session?.views.get(binding.threadId)?.historyCheckpoint ?? null : null,
    };
  };

  const hydrateBinding = (
    binding: ConversationBinding,
    force: boolean,
    retryRejected = false,
    checkpointCapture?: ReturnType<typeof captureHistoryCheckpoint>,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new AppServerClientError("ABORTED", "Thread recovery was superseded"));
    if (binding.disposed)
      return Promise.reject(
        new Error(`Thread ${binding.threadId} is disposed`),
      );
    const unavailable = unavailableThreads.get(binding.threadId);
    if (unavailable) {
      markThreadUnavailable(binding.threadId, unavailable.reason, unavailable.error);
      return Promise.reject(unavailable.error);
    }
    if (binding.hydrationOperation !== null) {
      if (binding.hydrationConnectionRevision === connectionRevision && (!force || binding.hydrationForReconnect))
        return binding.hydrationOperation;
      binding.cancelHydration?.();
    }
    binding.hydrationForReconnect = force;
    const revision = connectionRevision;
    const availabilityRevision = availabilityRevisions.get(binding.threadId) ?? 0;
    binding.hydrationConnectionRevision = revision;
    let active = true;
    const controller = new AbortController();
    let stopPreview: (() => void) | undefined;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const result = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const current = () => active && !disposed && !binding.disposed && revision === connectionRevision
      && binding.hydrationOperation === operation
      && availabilityRevision === (availabilityRevisions.get(binding.threadId) ?? 0);
    const cancel = () => {
      if (!active) return;
      active = false;
      if (binding.hydrationOperation === operation) {
        binding.hydrationOperation = null;
        binding.hydrationForReconnect = false;
        binding.cancelHydration = null;
      }
      signal?.removeEventListener("abort", cancel);
      reject(new AppServerClientError("ABORTED", "Thread recovery was superseded"));
      stopPreview?.();
      binding.replica.disconnect();
      controller.abort();
    };
    const operation = result.finally(() => {
      active = false;
      signal?.removeEventListener("abort", cancel);
      if (binding.hydrationOperation === operation) {
        binding.hydrationOperation = null;
        binding.hydrationForReconnect = false;
        binding.cancelHydration = null;
      }
      if (!binding.disposed && !disposed) { pruneInactiveBindings(); publish(); }
    });
    binding.hydrationOperation = operation;
    binding.cancelHydration = cancel;
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    void Promise.resolve()
      .then(async () => {
        if (!current()) throw new AppServerClientError("ABORTED", "Thread recovery was superseded");
        const currentSession = requireSession();
        const captured = checkpointCapture ?? captureHistoryCheckpoint(binding);
        const historyCheckpoint = force && captured.session === currentSession && captured.revision === connectionRevision
          ? captured.checkpoint : null;
        // Entering sync revokes authority. Capture eligibility from the attached
        // transcript first; active Turns and replacement connections still reload.
        binding.phase = force ? "reconnecting" : "hydrating";
        binding.replica.reportSyncStarted();
        touchBinding(binding);
        publish();
        if (!current()) throw new AppServerClientError("ABORTED", "Thread recovery was superseded");
        if (force) binding.replica.disconnect();
        stopPreview = currentSession.views.subscribeThread(binding.threadId, () => {
          const view = currentSession.views.get(binding.threadId);
          if (current() && view?.resumeState === "resuming" && view.historySource === "message-window") {
            binding.replica.reportPreview(binding.threadId, projectThreadViewForReplica(view));
          }
        });
        const extensions = requireClient().initializeResult?.capabilities?.extensions;
        const legacyWindow = executionEngineExtension(extensions, binding.threadId, "opencraft/message-window-history")?.version === 1
          && executionEngineExtension(extensions, binding.threadId, "opencraft/read-history")?.version !== 1;
        try {
          if (ephemeralThreadIds.has(binding.threadId)) {
            const view = currentSession.views.get(binding.threadId);
            if (view?.resumeState !== "resumed" || view.connectionGeneration !== requireClient().connectionGeneration) {
              throw new Error("This temporary side chat expired after disconnect. Start a new side chat.");
            }
          } else if (legacyWindow) {
            // Message-window providers bootstrap their REST preview through
            // Resume until they explicitly advertise a read-only history path.
            await currentSession.resume.resume({ threadId: binding.threadId, force, retryRejected, signal: controller.signal,
              unresolvedTurnIds: [...binding.acceptedTurnIds], ...(force ? { historyCheckpoint } : {}) });
          } else {
            await currentSession.resume.read(binding.threadId, { signal: controller.signal, historyCheckpoint, unresolvedTurnIds: [...binding.acceptedTurnIds] });
          }
          if (!current()) throw new AppServerClientError("ABORTED", "Thread recovery was superseded");
          if (legacyWindow) void recovery.span("capability-ready", () => ensureBindingCapabilities(binding)).catch(() => undefined);
        } finally { stopPreview?.(); }
        const source = createThreadViewReplicaSource(
          currentSession.views,
          hostId,
          binding.threadId,
          binding.projectionCache,
          duration => recovery.projection(duration),
        );
        await recovery.span("replica-ready", () => binding.replica.synchronize(source));
        if (!current()) return;
        // Queue notifications can be lost with the old connection, including
        // the receipt for a locally persisted input. Reconcile independently
        // after history authority returns; do not wait for another queue event.
        if (force && !ephemeralThreadIds.has(binding.threadId))
          void binding.refreshQueue().catch(() => undefined);
        binding.phase = "resident";
        touchBinding(binding);
      })
      .catch((cause) => {
        if (current()) {
          const reason = threadUnavailableReason(cause);
          if (reason !== null) markThreadUnavailable(binding.threadId, reason, cause as AppServerRpcError);
          binding.phase = "error";
          if (binding.replica.getSnapshot().lastError === null) {
            binding.replica.reportSyncFailure(cause);
          }
        }
        throw cause;
      })
      .then(resolve, reject);
    return operation;
  };

  const connectPhysicalHost = async (
    generation = lifecycleGeneration,
    attempt?: ConnectionAttempt,
  ): Promise<ConnectionBinding> => {
    ensureLifecycle(generation);
    attempt?.assertCurrent();
    const currentClient = requireClient();
    const transport = currentTransport;
    const revision = connectionRevision;
    connectionObservation = { client: currentClient, revision, attempt };
    attempt?.progress(transport?.status.state === "open" ? "initialize" : "transport",
      transport?.status.state === "open" ? Math.max(30_000, config.requestTimeoutMs ?? 30_000) + 5_000 : 45_000);
    if (currentClient.initializeResult === null) recovery.connectionStage(currentTransport?.status.state === "open" ? "initializing" : "connecting");
    await currentClient.connect(config.initialize ?? defaultInitialize, attempt?.signal, attempt?.assertCurrent);
    ensureLifecycle(generation);
    attempt?.assertCurrent();
    if (currentClient !== client || transport === null || transport !== currentTransport
      || revision !== connectionRevision || transport.status.state !== "open" || currentClient.initializeResult === null) {
      throw new AppServerClientError("NOT_CONNECTED", "Host disconnected during initialization");
    }
    return { client: currentClient, transport, generation: currentClient.connectionGeneration, revision };
  };

  const recoveryDemand = (binding: ConversationBinding): RecoveryDemand => {
    if (binding.disposed || unavailableThreads.has(binding.threadId)) return "cache";
    if (binding.visibleCount > 0) return "visible";
    const activity = bindingActivity(binding);
    return binding.runtime.getSnapshot().queuedSubmissions.some(item => item.local)
        || (pendingViewAcquires.get(binding.threadId) ?? 0) > 0
        || binding.retainCount > 0 || binding.pendingCommandCount > 0 || binding.acceptedTurnIds.size > 0
        || activity.activeStreamCount > 0 || activity.pendingInteractionCount > 0 ? "open" : "cache";
  };

  const retryableHistoryFailure = (cause: unknown) => !disposed && phase === "ready"
    && threadUnavailableReason(cause) === null
    && ((cause instanceof AppServerClientError
      && ["TIMEOUT", "QUEUE_FULL", "TRANSPORT_ERROR", "NOT_CONNECTED"].includes(cause.code))
      || isRetryableAppServerRpcError(cause)
      // History recovery is read-only. Legacy providers use generic server/internal
      // errors without a retry hint; explicit permanent failures still stop.
      || (cause instanceof AppServerRpcError && [-32000, -32603].includes(cause.code)
        && (cause.data == null || (typeof cause.data === "object"
          && (!("retryable" in cause.data) || cause.data.retryable === true)))));

  // Resource restoration is not part of Host readiness. A missing Thread
  // must not reconnect the Host or delay another Thread's restoration.
  const restoreResources = () => {
    const revision = connectionRevision;
    const current = () => !disposed && revision === connectionRevision && phase === "ready";
    void terminalController?.reconnect().catch(() => undefined);
    void restoreFileSystemWatches().catch(() => undefined);
    recovery.begin("resources");
    for (const binding of [...bindings.values()].sort((a, b) => b.visibleCount - a.visibleCount || b.touchedAt - a.touchedAt)) {
      void recovery.recover({ key: binding, demand: () => current() ? recoveryDemand(binding) : "cache",
        run: async signal => {
          if (!current()) return;
          requireSession().resume.markNeedsResume(binding.threadId);
          await hydrateBinding(binding, true, true, undefined, signal);
        },
        retryable: cause => current() && retryableHistoryFailure(cause),
      }).catch(() => undefined);
    }
    recovery.scheduled();
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

  // Cancellation stops waiting, not the external operation. A late resource
  // is disposed by its own continuation and never assigned to Runtime fields.
  const duringAttempt = <T>(operation: Promise<T>, attempt: ConnectionAttempt,
    disposeLate: (value: T) => Promise<unknown>): Promise<T> => new Promise((resolve, reject) => {
    let revoked = false;
    const abort = () => { revoked = true; reject(attempt.signal.reason ?? new Error("Connection attempt revoked")); };
    attempt.signal.addEventListener("abort", abort, { once: true });
    if (attempt.signal.aborted) abort();
    void operation.then(value => {
      attempt.signal.removeEventListener("abort", abort);
      if (revoked) { void disposeLate(value).catch(() => undefined); return; }
      resolve(value);
    }, cause => { attempt.signal.removeEventListener("abort", abort); reject(cause); });
  });

  const initializeServices = (attempt: ConnectionAttempt): Promise<void> => {
    if (disposed)
      return Promise.reject(new Error("AppServer Workbench is disposed"));
    if (client !== null && session !== null && commandPort !== null) {
      return Promise.resolve();
    }
    if (initializeServicesOperation !== null)
      return initializeServicesOperation;
    const generation = lifecycleGeneration;
    let attemptTransport: DuplexTransport | null = null;
    const operation = Promise.resolve().then(async () => {
      const registry = config.clientRegistry === undefined
        ? await duringAttempt(createCordisAppServerRegistry(), attempt, value => value.dispose()) : null;
      ownedRegistry = registry;
      ensureLifecycle(generation);
      attempt.assertCurrent();
      const clientRegistry = config.clientRegistry ?? ownedRegistry!.clients;
      attemptTransport = config.createTransport?.() ?? config.transport ?? null;
      if (attemptTransport === null) {
        throw new Error("AppServer transport factory did not create a transport");
      }
      initializationFailureStatus = null;
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
        if (notification.method === "opencraft/turn-recovery/updated") {
          const value = notification.params as { threadId: string; recovery: import("@opencraft/appserver-protocol").TurnRecoveryNotice | null };
          turnRecovery.observe(value.threadId, value.recovery);
        }
        const threadId = (notification.params as { threadId?: unknown } | null)?.threadId;
        if (typeof threadId === "string") {
          if (notification.method === "thread/archived") markThreadUnavailable(threadId, "archived");
          else if (notification.method === "thread/deleted") markThreadUnavailable(threadId, "not-found");
          else if (notification.method === "thread/unarchived") markThreadAvailable(threadId);
        }
        if (notification.method === "opencraft/schedules/changed") {
          for (const listener of schedulesChangedListeners) { try { listener(); } catch { /* Isolate observers. */ } }
        }
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
      removeRecoveryMetrics = client.subscribeRequestLifecycle(event => {
        if (!recovery.observing) return;
        if (event.type === "started") recovery.requestStarted();
        if (event.type !== "completed" && event.type !== "failed" && event.type !== "timed-out" && event.type !== "aborted") return;
        recovery.response(event.responseBytes ?? 0);
        if (["initialize", "thread/resume", "thread/read", "thread/turns/list", "thread/items/list"].includes(event.method)
          && (event.type !== "completed" || event.durationMs >= 1_000))
          recovery.stage(event.type !== "completed" ? "request-failed" : "request-slow", {
            method: event.method, durationMs: event.durationMs, responseBytes: event.responseBytes ?? 0,
          });
        if (event.type !== "completed") return;
        if (event.method === "thread/resume") {
          const metrics = (event.result as { historyMetrics?: { nativeReads: number; nativeEvents: number; projectionMs: number } })?.historyMetrics;
          if (metrics && [metrics.nativeReads, metrics.nativeEvents, metrics.projectionMs].every(n => Number.isFinite(n) && n >= 0))
            recovery.stage("provider-history", { nativeReads: metrics.nativeReads, nativeEvents: metrics.nativeEvents, projectionMs: metrics.projectionMs });
        }
      });
      removeClientHandlers = config.installClientHandlers?.(client) ?? null;
      const observedClient = client;
      removeTransportListener = observedClient.subscribeStatus((status) => {
        if (disposed || client !== observedClient || connectionObservation?.client !== observedClient
          || connectionObservation.revision !== connectionRevision) return;
        const attempt = connectionObservation.attempt;
        if (attempt && !attempt.signal.aborted) {
          // Observers never throw into the shared socket's frame dispatcher.
          try {
            if (status.state === "connecting" && status.connectionStage)
              attempt.progress(status.connectionStage, status.connectionStage === "bridge" ? 15_000 : 35_000);
            if (status.state === "open" && observedClient.initializeResult === null)
              attempt.progress("initialize", Math.max(30_000, config.requestTimeoutMs ?? 30_000) + 5_000);
          } catch { return; }
        }
        if (status.state === "open" && observedClient.initializeResult === null) recovery.connectionStage("initializing");
        if (status.state !== "closed" && status.state !== "failed") return;
        if (status.failure?.recovery === "manual") automaticReconnectBlock = status;
        connection.lost(status.reason === undefined ? new Error("Host connection lost") : new Error(status.reason),
          status.failure?.recovery === "manual");
      });
      removeRecoveryHintListener = currentTransport?.subscribeRecoveryHint?.(() => {
        if (disposed || config.autoReconnect === false || !connection.admitRecoveryHint()) return;
        if (phase !== "ready") {
          void connection.connect(true).catch(() => undefined);
        } else {
          for (const binding of bindings.values()) {
            if (binding.visibleCount === 0 || binding.runtime.getSnapshot().authoritative) continue;
            void recovery.recover({ key: binding, demand: () => recoveryDemand(binding),
              run: signal => hydrateBinding(binding, true, true, undefined, signal), retryable: retryableHistoryFailure,
            }, true).catch(() => undefined);
          }
        }
      }) ?? null;
      await duringAttempt(connectPhysicalHost(generation, attempt), attempt, async () => {});
      ensureLifecycle(generation);
      goals.reset();
      turnRecovery.reset();
      orchestration.reset();
      const historyModeHint = () => {
        const capability = client?.initializeResult?.capabilities?.extensions?.[
          OPENCRAFT_RESUME_HISTORY_EXTENSION
        ] as { version?: unknown; mode?: unknown } | undefined;
        return capability?.version === 1 && ["legacy", "paginated", "message-window"].includes(String(capability.mode))
          ? capability.mode as "legacy" | "paginated" | "message-window" : null;
      };
      attempt.progress("session");
      session = await duringAttempt(createCordisThreadSessionRuntime({
        client,
        frameScheduler: config.frameScheduler,
        readClock: { now: () => clock.now?.() ?? recoveryNow(),
          setTimeout: (run, ms) => clock.setTimeout(run, ms), clearTimeout: timer => clock.clearTimeout(timer) },
        hostKind:
          config.hostKind ?? (hostId === "durable" ? "durable" : "local"),
        supportsPaginatedHistory: true,
        historyModeHint,
        useTailHydration: true,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      }), attempt, value => value.dispose());
      ensureLifecycle(generation);
      attempt.assertCurrent();
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
        canRequest,
        interactions,
        get queueAtomicSteer() { return supportsAtomicQueuedSteer(
          client?.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_QUEUE_EXTENSION]); },
        get queueUnconfirmedSteerDiscard() { return supportsUnconfirmedSteerDiscard(
          client?.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_QUEUE_EXTENSION]); },
        compiler: { historyMode: "paginated" },
        modelSelectionPolicy: config.modelSelectionPolicy,
        resolveCompilerOptions: async (intent) => {
          const followUp = intent.target.type === "steer-active-turn" || intent.target.type === "enqueue-follow-up";
          const threadId = intent.target.type === "new-thread" ? null : intent.target.key.threadId;
          const useHostDefault = !followUp && (
            config.modelSelectionPolicy === "host-default"
            || (config.modelSelectionPolicy === "session" && intent.target.type === "new-thread" && intent.selections.model === undefined)
          );
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
              if (config.modelSelectionPolicy === "session" && intent.selections.model !== undefined && config.readSelectableModels) {
                let choices: readonly SelectableModelPresentation[] | null = null;
                try {
                  choices = await config.readSelectableModels([model], { preferCached: true });
                } catch {
                  // Model Settings is advisory when its remote read is unavailable; the Host still validates the model.
                }
                if (choices && !choices.some((choice) => choice.id === model.id)) throw new Error("所选模型已不可用，请重新选择");
              }
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
        dynamicTools: declaredDynamicTools(),
        onInterrupt: (event) => console.info("[turn-interrupt] client request", event),
      });
    })
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
          automaticReconnectBlock ??= {
            state: "closed",
            reason: "The fixed AppServer transport generation was closed after initialization failed",
            failure: { code: "fixed-transport-generation-closed", recovery: "manual" },
          };
          connection.lost(cause, true);
        }
        if (attemptTransport?.status.failure?.diagnostic) initializationFailureStatus = attemptTransport.status;
        removeTransportListener?.();
        removeTransportListener = null;
        removeRecoveryHintListener?.();
        removeRecoveryHintListener = null;
        removeRecoveryMetrics?.(); removeRecoveryMetrics = null;
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
        // Detach shared fields before any untrusted async cleanup. Each
        // disposer captures its retired bundle and can never clear a successor.
        const failedTerminal = terminalController, failedSession = session;
        const failedRegistry = ownedRegistry, failedClient = client;
        terminalController = null;
        session = null;
        ownedRegistry = null;
        client = null;
        commandPort = null;
        connectionObservation = null;
        if (currentTransport === attemptTransport) currentTransport = null;
        // remove() deletes the registry claim synchronously, before close awaits
        // transport I/O. Start it before a successor can create the same host.
        const closeClient = failedRegistry !== null ? failedRegistry.clients.remove(hostId)
          : failedClient !== null ? config.clientRegistry!.remove(hostId)
          : attemptTransport?.close();
        void Promise.allSettled([
          closeClient, failedTerminal?.dispose(), failedSession?.dispose(), failedRegistry?.dispose(),
        ]);
        throw cause;
      })
      .finally(() => {
        if (initializeServicesOperation === operation)
          initializeServicesOperation = null;
      });
    initializeServicesOperation = operation;
    return operation;
  };

  const localOutboxes = new Map<string, ConversationOutbox>();
  const localOutbox = (threadId: string): ConversationOutbox | null => {
    if (!config.outbox || disposed) return null;
    let owner = localOutboxes.get(threadId);
    if (!owner) {
      owner = createConversationOutbox({ key: createConversationKey(hostId, requireThreadId(threadId)), storage: config.outbox,
        ready: () => false, blocked: () => true, publish() {}, retire() {}, sender: config.getSubmissionSender,
        send: async () => { throw new Error("A live Thread binding is required before dispatch"); },
      });
      localOutboxes.set(threadId, owner);
    }
    return owner;
  };
  const runtime: AppServerWorkbenchRuntime = {
    resources: {
      protocol: {
        request(method, params, options) {
          assertMethodAccess(method);
          return requireClient().request(method, params, options);
        },
      },
      goals,
      turnRecovery,
      orchestration,
      host: {
        subscribeSchedulesChanged(listener) {
          if (disposed) throw new Error("AppServer Workbench is disposed");
          schedulesChangedListeners.add(listener);
          return () => { schedulesChangedListeners.delete(listener); };
        },
        canRequest: method => client?.initializeResult != null && canRequest(method),
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
        getUnavailableReason: threadId => unavailableThreads.get(threadId)?.reason ?? null,
        subscribeUnavailable(listener) { unavailableListeners.add(listener); return () => { unavailableListeners.delete(listener); }; },
        capabilities(threadId) {
          const extension = (key: string) => executionEngineExtension(client?.initializeResult?.capabilities?.extensions, threadId, key);
          const reference = extension("opencraft/collaboration") !== undefined;
          const capability = parseThreadLifecycleCapability(extension(OPENCRAFT_THREAD_LIFECYCLE_EXTENSION));
          return { reference, fork: capability?.fork === true, rename: capability?.rename === true, archive: capability?.archive === true, delete: capability?.delete === true,
            pin: (extension(OPENCRAFT_THREAD_LIFECYCLE_EXTENSION)?.pin !== false) && client !== null && threadPins?.client === client && threadPins.generation === client.connectionGeneration && threadPins.resource.available() };
        },
        async setPinned(threadId, pinned) { await pinResource(requireClient()).set(threadId, pinned); },
        async rename(threadId, name) { await requireClient().request("thread/name/set", { threadId, name }); },
        async delete(threadId) { await requireClient().request("thread/delete", { threadId }); markThreadUnavailable(threadId, "not-found"); },
        async archive(threadId) { await requireClient().request("thread/archive", { threadId }); markThreadUnavailable(threadId, "archived"); },
        async unarchive(threadId) {
          const currentClient = requireClient(), generation = currentClient.connectionGeneration;
          const revision = availabilityRevisions.get(threadId) ?? 0;
          const thread = (await currentClient.request("thread/unarchive", { threadId })).thread as ProtocolThread;
          // A later native resource fact wins over an earlier mutation's ACK.
          if (client === currentClient && generation === currentClient.connectionGeneration
            && revision === (availabilityRevisions.get(threadId) ?? 0)) markThreadAvailable(threadId);
          return thread;
        },
        supportsSideChat(threadId) {
          const capability = parseThreadLifecycleCapability(executionEngineExtension(requireClient().initializeResult?.capabilities?.extensions, threadId, OPENCRAFT_THREAD_LIFECYCLE_EXTENSION));
          return (capability?.fork === true || capability?.ephemeralFork === true) && capability.ephemeral === true && capability.injectItems === true && capability.unsubscribe === true;
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
          // Temporary ownership ends here even if its final projection has not
          // settled yet. Only a new consumer can require reattachment.
          const retained = current && (ephemeralThreadIds.has(threadId) ? current.retainCount > 0 : hasHardResidencyReason(current));
          if (current && (current !== binding || retained)) {
            // The unsubscribe won on the wire; the new consumer must actually
            // reattach, not merely retain a stale local projection.
            requireSession().resume.markNeedsResume(threadId);
            await hydrateBinding(current, true);
            return;
          }
          if (current) disposeBinding(current);
          ephemeralThreadIds.delete(threadId);
          requireSession().resume.release(threadId);
        },
        async list(params = {}) {
          const current = requireClient(), generation = current.connectionGeneration;
          const response = await current.request("thread/list", {
            archived: false,
            cursor: null,
            limit: 30,
            sortDirection: "desc",
            sortKey: "updated_at",
            // SSH discovery is a hot catalog read, not a filesystem
            // reconciliation. Keep the policy here so all catalog consumers
            // share it; an explicit repair caller can still override it.
            ...(config.hostKind === "remote-ssh" ? { useStateDbOnly: true } : {}),
            ...params,
          });
          const defaultCatalog = Object.keys(params).every(key => key === "cursor" || key === "limit")
            && params.cursor == null;
          if (defaultCatalog && supportsThreadPinDiscovery(current.initializeResult?.capabilities?.extensions?.[OPENCRAFT_THREAD_PINS_EXTENSION])) {
            const pins = await pinResource(current).read();
            if (client !== current || current.connectionGeneration !== generation) throw new Error("Thread catalog connection changed");
            const pinned = new Map(pins.data.map(thread => [thread.id, thread]));
            response.data = [
              ...pins.data.map(thread => ({ ...thread, pinned: true })),
              ...response.data.filter(thread => !pinned.has(thread.id)).map(thread => ({ ...thread, pinned: false })),
            ];
          }
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
          // Catalog rows are metadata, not read subscriptions. Do not create
          // unbounded Session Views merely by paging the sidebar directory.
          for (const thread of response.data) {
            catalogMetadata.delete(thread.id);
            catalogMetadata.set(thread.id, { ...thread, turns: [] });
            if (bindings.has(thread.id)) views.seedMetadata(thread);
          }
          while (catalogMetadata.size > (config.maxCachedThreadMetadata ?? 128)) {
            catalogMetadata.delete(catalogMetadata.keys().next().value!);
          }
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
              : { dynamicTools: [...(declaredDynamicTools() ?? [])] }),
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
          assertMethodAccess("fs/watch");
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
          assertMethodAccess("fuzzyFileSearch/sessionStart");
          if (fuzzyFileSearch === null) {
            return Promise.reject(
              new Error("AppServer fuzzy file search is unavailable"),
            );
          }
          return fuzzyFileSearch.createSession(options);
        },
      },
      attachments: {
        async uploadChunk(params) {
          const capability = runtime.resources.attachments.capabilities();
          if (!capability?.chunkBytes || params.size > capability.maxBytes) throw new Error("Host does not support this attachment upload");
          return requireClient().request("attachment/uploadChunk", params, {
            timeoutMs: params.offset + capability.chunkBytes >= params.size ? 60 * 60_000 : 30_000,
          });
        },
        async uploadCancel(uploadId) {
          return requireClient().request("attachment/uploadCancel", { uploadId });
        },
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
          return listSelectableModels({
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
            serviceTier: typeof response.config.service_tier === "string" ? response.config.service_tier : null,
            model: typeof response.config.model === "string"
              ? response.config.model
              : null,
            effort: typeof response.config.model_reasoning_effort === "string"
              ? response.config.model_reasoning_effort
              : null,
          };
        },
        async writeNewThreadDefaults(defaults) {
          // A Host-default presentation submits the Host's current model; it owns no configuration intent.
          if (config.modelSelectionPolicy === "host-default" || config.modelSelectionPolicy === "session") return;
          assertMethodAccess("config/batchWrite");
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
          const scoped = client?.initializeResult?.capabilities?.extensions?.[SCOPED_SKILL_CATALOG_EXTENSION] as { version?: unknown } | undefined;
          if (scoped?.version === 1) {
            assertMethodAccess(SCOPED_SKILL_CATALOG_METHOD);
            return requireClient().request(SCOPED_SKILL_CATALOG_METHOD, params);
          }
          if (client?.initializeResult?.capabilities?.extensions?.["opencraft/execution-engines"] !== undefined) {
            throw new Error("This Host requires an update for engine-scoped Skill discovery");
          }
          // Old/native Hosts must not receive the OpenCraft routing fields.
          const { threadId: _thread, model: _model, ...native } = params;
          assertMethodAccess("skills/list");
          return requireClient().request("skills/list", {
            cwds: [],
            forceReload: false,
            ...native,
          });
        },
        createFuzzyFileSearchSession(options) {
          assertMethodAccess("fuzzyFileSearch/sessionStart");
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
          assertMethodAccess("process/attach");
          if (phase !== "ready" || terminalController === null) throw new Error("Terminal Host is not ready");
          return terminalController.attach(processId);
        },
        list() {
          assertMethodAccess("process/list");
          if (phase !== "ready" || terminalController === null) throw new Error("Terminal Host is not ready");
          return terminalController.list();
        },
        open(options) {
          assertMethodAccess("process/spawn");
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
    localOutbox,
    connect() { return connection.connect(); },
    reconnect() { return connection.connect(true); },
    async acquireThread(nextThreadId) {
      const threadId = requireThreadId(nextThreadId);
      // Reserve View demand before any asynchronous binding publication. Queue
      // observers may prune a newly published binding before this await resumes.
      pendingViewAcquires.set(threadId, (pendingViewAcquires.get(threadId) ?? 0) + 1);
      let binding: ConversationBinding;
      try {
        await runtime.connect();
        binding = await createBinding(threadId);
        if (disposed || binding.disposed) throw new Error(`Thread ${threadId} is disposed`);
        binding.retainCount += 1;
      } finally {
        const remaining = (pendingViewAcquires.get(threadId) ?? 1) - 1;
        if (remaining > 0) pendingViewAcquires.set(threadId, remaining);
        else pendingViewAcquires.delete(threadId);
      }
      touchBinding(binding);
      binding.phase =
        binding.hydrationOperation === null ? "resident" : binding.phase;
      publish();
      if (!binding.runtime.getSnapshot().authoritative) {
        // Acquisition does not wait on the network waterfall, but the V3 View
        // adapter must publish no persisted Timeline before Resume. The single
        // authoritative promotion happens after Resume + history settle.
        if (client?.status.state === "open") void recovery.recover({ key: binding, demand: () => recoveryDemand(binding),
          run: signal => hydrateBinding(binding, false, true, undefined, signal), retryable: retryableHistoryFailure,
        }).catch(() => undefined);
      }
      let released = false;
      let visible = false;
      return {
        threadId,
        setRecoveryVisibility(next: boolean) {
          if (released || visible === next) return;
          visible = next; binding.visibleCount += next ? 1 : -1;
          if (next && phase === "ready" && !binding.runtime.getSnapshot().authoritative) {
            // Promote this binding's pending recovery without revalidating peer
            // Threads or restoring Host resources on ordinary navigation.
            void recovery.recover({ key: binding, demand: () => recoveryDemand(binding),
              run: signal => hydrateBinding(binding, false, true, undefined, signal), retryable: retryableHistoryFailure,
            }).catch(() => undefined);
          }
        },
        getSnapshot: binding.runtime.getSnapshot,
        retryRestore() {
          if (released || binding.disposed) return Promise.reject(new Error(`Thread ${threadId} lease is released`));
          const checkpoint = captureHistoryCheckpoint(binding);
          binding.replica.reportSyncStarted();
          recovery.begin("revalidate");
          return recovery.recover({ key: binding, demand: () => recoveryDemand(binding),
            run: signal => recovery.span("history-authoritative", () => hydrateBinding(binding, true, true, checkpoint, signal)),
            retryable: retryableHistoryFailure, propagateFailure: true,
          }, true);
        },
        async refreshHistory(signal) {
          if (released || binding.disposed || signal?.aborted) return false;
          const snapshot = binding.runtime.getSnapshot();
          if (phase !== "ready" || !snapshot.authoritative || snapshot.activeTurn !== null || binding.pendingCommandCount > 0 || binding.acceptedTurnIds.size > 0) return false;
          return requireSession().resume.refreshHistory(threadId, signal);
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
            retireUnobservedHistory(binding);
            touchBinding(binding);
            pruneInactiveBindings();
            publish();
          };
        },
        submit: (intent) =>
          runBindingCommand(binding, async () => {
            // Refuse before Conversation adopts the immutable draft/optimistic
            // queue. Transport failure after adoption is a different boundary.
            if (!config.outbox || (phase === "ready" && binding.runtime.getSnapshot().authoritative && !binding.runtime.getSnapshot().queuedSubmissions.some(item => item.local))) assertMethodAccess(intent.target.type === "enqueue-follow-up" ? "thread/queue/add"
              : intent.target.type === "steer-active-turn" ? "turn/steer" : "turn/start");
            // Online first inputs can own ready asset/context references while
            // the new Thread is still hydrating. Keep that custody on this
            // command; the offline text outbox cannot persist these handles.
            if (phase === "ready" && !binding.runtime.getSnapshot().authoritative
              && (intent.attachments.length > 0 || intent.context.length > 0)) {
              assertMethodAccess(intent.target.type === "enqueue-follow-up" ? "thread/queue/add"
                : intent.target.type === "steer-active-turn" ? "turn/steer" : "turn/start");
              await hydrateBinding(binding, false);
              if (released || binding.disposed) throw new Error(`Thread ${threadId} lease is released`);
            }
            const invalidateQueueRead = () => {
              if (intent.target.type === "enqueue-follow-up" && binding.queueRefreshOperation !== null)
                binding.queueRefreshRequested = true;
            };
            // A read started before local admission cannot remove its pending
            // row, even when the Host's change notification has not arrived yet.
            invalidateQueueRead();
            try {
              const receipt = await binding.runtime.submit(intent);
              if (receipt.turnId !== null)
                retainAcceptedTurn(binding, receipt.turnId);
              return receipt;
            } finally {
              invalidateQueueRead();
            }
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
        loadOlder: () => {
          if (released || binding.disposed) return Promise.reject(new Error(`Thread ${threadId} lease is released`));
          return binding.runtime.loadOlder();
        },
        getNavigation: () => binding.navigation,
        release() {
          if (released) return;
          released = true;
          if (visible) binding.visibleCount = Math.max(0, binding.visibleCount - 1);
          binding.retainCount = Math.max(0, binding.retainCount - 1);
          retireUnobservedHistory(binding);
          if (recoveryDemand(binding) === "cache") { recovery.remove(binding); binding.cancelHydration?.(); }
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
      await runtime.connect();
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
      let resolve!: () => void, reject!: (cause: unknown) => void;
      const operation = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      disposeOperation = operation;
      void (async () => {
        if (disposed) return;
        connection.dispose();
        recovery.dispose();
        orchestration.dispose();
        if (detachRetryTimer !== null) clock.clearTimeout(detachRetryTimer);
        detachRetryTimer = null;
        failedReadDetaches.clear();
        disposed = true;
        for (const owner of localOutboxes.values()) owner.dispose();
        localOutboxes.clear();
        lifecycleGeneration += 1;
        removeTransportListener?.();
        removeTransportListener = null;
        removeRecoveryHintListener?.();
        removeRecoveryHintListener = null;
        removeRecoveryMetrics?.(); removeRecoveryMetrics = null;
        removeClientHandlers?.();
        removeClientHandlers = null;
        removeFileSystemNotificationListener?.();
        removeFileSystemNotificationListener = null;
        removeSkillsNotificationListener?.();
        removeSkillsNotificationListener = null;
        removeGoalNotificationListener?.();
        removeGoalNotificationListener = null;
        skillsChangedListeners.clear();
        schedulesChangedListeners.clear();

        const pending = [
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
        catalogMetadata.clear();
        detachOperations.clear();
        ownedRegistry = null;
        client = null;
        commandPort = null;
        listeners.clear();
      })().then(resolve, reject);
      return operation;
    },
  };

  return runtime;
}
